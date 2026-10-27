import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A throwaway data directory per run, so the real one is never touched.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "donex-oauth-"));
process.env.DATA_DIR = DIR;

const { googleRepo, settingsRepo } = await import("@/lib/db/repos");
const { exchangeCode, getAccessToken, googleFetch, GOOGLE_EXPIRED, GOOGLE_NOT_CONNECTED } = await import(
  "@/lib/google/oauth"
);

const PAST = new Date(Date.now() - 60_000).toISOString();
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();

const original = {
  accessToken: "old-access",
  refreshToken: "refresh-1",
  expiry: PAST,
  email: "first@example.com",
  scopes: ["openid"],
};

/** Google's token endpoint, with `during` run while the request is "in flight". */
function tokenEndpoint(body: Record<string, unknown>, during: () => void, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      during();
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

beforeAll(() => {
  settingsRepo.updateApp({ google: { clientId: "client-id", clientSecret: "client-secret" } });
});

beforeEach(() => {
  googleRepo.save(original);
});

afterEach(() => {
  vi.unstubAllGlobals();
  googleRepo.clear();
});

afterAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("token refresh", () => {
  it("stores the refreshed token when nothing changed meanwhile", async () => {
    tokenEndpoint({ access_token: "new-access", expires_in: 3600 }, () => {});
    await expect(getAccessToken()).resolves.toBe("new-access");
    const stored = googleRepo.get();
    expect(stored?.accessToken).toBe("new-access");
    expect(stored?.refreshToken).toBe("refresh-1");
  });

  it("does not bring the connection back after a disconnect mid-refresh", async () => {
    tokenEndpoint({ access_token: "new-access", expires_in: 3600 }, () => googleRepo.clear());
    await expect(getAccessToken()).rejects.toThrow(GOOGLE_NOT_CONNECTED);
    expect(googleRepo.get()).toBeNull();
  });

  it("does not overwrite a reconnect that landed mid-refresh", async () => {
    const reconnected = {
      accessToken: "second-access",
      refreshToken: "refresh-2",
      expiry: FUTURE,
      email: "second@example.com",
      scopes: ["openid", "email"],
    };
    tokenEndpoint({ access_token: "stale-access", expires_in: 3600 }, () =>
      googleRepo.save(reconnected),
    );
    await expect(getAccessToken()).resolves.toBe("second-access");
    expect(googleRepo.get()).toEqual(reconnected);
  });

  it("clears an expired connection on invalid_grant", async () => {
    tokenEndpoint({ error: "invalid_grant" }, () => {}, 400);
    await expect(getAccessToken()).rejects.toThrow(GOOGLE_EXPIRED);
    expect(googleRepo.get()).toBeNull();
  });

  it("keeps a reconnect when the old refresh token comes back invalid_grant", async () => {
    const reconnected = { ...original, accessToken: "second-access", refreshToken: "refresh-2", expiry: FUTURE };
    tokenEndpoint({ error: "invalid_grant" }, () => googleRepo.save(reconnected), 400);
    await expect(getAccessToken()).resolves.toBe("second-access");
    expect(googleRepo.get()?.refreshToken).toBe("refresh-2");
  });
});

describe("googleFetch", () => {
  it("gives every call a timeout unless the caller brings a signal", async () => {
    googleRepo.save({ ...original, expiry: FUTURE });
    const seen: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push(init?.signal);
        return new Response("{}", { status: 200 });
      }),
    );
    await googleFetch("https://www.googleapis.com/x");
    const own = new AbortController();
    await googleFetch("https://www.googleapis.com/x", { signal: own.signal });
    expect(seen[0]).toBeInstanceOf(AbortSignal);
    expect(seen[1]).toBe(own.signal);
  });
});

describe("exchangeCode", () => {
  it("keeps Google's error code ahead of its description", async () => {
    tokenEndpoint({ error: "invalid_client", error_description: "Unauthorized" }, () => {}, 401);
    const request = new Request("https://donex.example/api/google/callback");
    await expect(exchangeCode("code", request)).rejects.toThrow("invalid_client: Unauthorized");
  });
});
