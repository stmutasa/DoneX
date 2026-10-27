import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// A throwaway data directory per run, so the real one is never touched.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "donex-auth-"));
process.env.DATA_DIR = DIR;

/** One browser's cookie jar, as next/headers' cookies() sees it. */
const jar = new Map<string, string>();
const deviceSets: { value: string; maxAge?: number }[] = [];
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string, opts?: { maxAge?: number }) => {
      jar.set(name, value);
      if (name === "donex_device") deviceSets.push({ value, maxAge: opts?.maxAge });
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
  headers: async () => new Headers({ "user-agent": "family-laptop" }),
}));

const auth = await import("@/lib/auth");
const { getDb } = await import("@/lib/db");
const { pushRepo, sessionsRepo, settingsRepo } = await import("@/lib/db/repos");
const login = await import("@/app/api/auth/login/route");
const forget = await import("@/app/api/push/forget/route");

afterAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

const MIN = 60_000;
const FREE = 5;
const T0 = 1_700_000_000_000;
const ip = (n: number) => ({ key: `ip:10.0.0.${n}`, trusted: false });
const device = (n: number) => ({ key: `device:${n}`, trusted: true });

/** Claims and settles one wrong PIN; returns the wait when locked out. */
function miss(client: { key: string; trusted: boolean }, now: number): number | null {
  const a = auth.claimLoginAttempt(client, now);
  if ("retryAfter" in a) return a.retryAfter;
  a.settle(null);
  return null;
}

describe("login limiter", () => {
  beforeEach(() => auth.__resetLoginLimiterForTests());

  it("lets only five parallel guesses through before any of them settles", () => {
    const claims = Array.from({ length: 50 }, () => auth.claimLoginAttempt(ip(1), T0));
    const passed = claims.filter((c) => "settle" in c);
    expect(passed).toHaveLength(5);
  });

  it("locks a client out for longer with every further miss", () => {
    for (let i = 0; i < 5; i++) expect(miss(ip(1), T0)).toBeNull();
    expect(miss(ip(1), T0)).toBe(60);
    expect(miss(ip(1), T0 + MIN)).toBeNull(); // sixth miss
    expect(miss(ip(1), T0 + MIN)).toBe(120);
    expect(miss(ip(1), T0 + 3 * MIN)).toBeNull(); // seventh
    expect(miss(ip(1), T0 + 3 * MIN)).toBe(240);
  });

  it("caps the lockout at an hour", () => {
    let now = T0;
    for (let i = 0; i < 15; i++) {
      const wait = miss(device(1), now);
      if (wait !== null) {
        now += wait * 1000;
        expect(miss(device(1), now)).toBeNull();
      }
    }
    expect(miss(device(1), now)).toBe(3600);
  });

  it("forgets the streak on the owner's PIN", () => {
    for (let i = 0; i < 4; i++) miss(ip(1), T0);
    const ok = auth.claimLoginAttempt(ip(1), T0);
    if ("retryAfter" in ok) throw new Error("should not be locked");
    ok.settle("owner");
    for (let i = 0; i < 5; i++) expect(miss(ip(1), T0)).toBeNull();
  });

  it("doesn't let the partner's PIN buy more guesses at the owner's", () => {
    // The probe that found the hole: 4 wrong guesses, her own PIN, repeat.
    for (const client of [ip(1), device(1)]) {
      let guesses = 0;
      for (let cycle = 0; cycle < 100; cycle++) {
        for (let i = 0; i < 4; i++) if (miss(client, T0) === null) guesses++;
        const own = auth.claimLoginAttempt(client, T0);
        if ("settle" in own) own.settle("partner");
      }
      expect(guesses).toBe(FREE);
    }
  });

  it("still lets the partner sign in without a miss of her own counting", () => {
    for (let i = 0; i < 4; i++) miss(ip(1), T0);
    const own = auth.claimLoginAttempt(ip(1), T0);
    if ("retryAfter" in own) throw new Error("should not be locked");
    own.settle("partner");
    expect(miss(ip(1), T0)).toBeNull(); // the fifth miss, not the sixth
    expect(miss(ip(1), T0)).toBe(60);
  });

  it("keeps one client's misses from locking out another", () => {
    for (let i = 0; i < 6; i++) miss(ip(1), T0);
    expect(miss(ip(1), T0)).not.toBeNull();
    expect(miss(ip(2), T0)).toBeNull();
  });

  it("closes sign-in to unrecognised clients after 20 misses a day, but not to known devices", () => {
    for (let n = 0; n < 20; n++) expect(miss(ip(n), T0 + n)).toBeNull();
    expect(miss(ip(99), T0 + 30)).toBeGreaterThan(23 * 3600);
    expect(miss(device(1), T0 + 30)).toBeNull();
    // A day after the oldest miss, one more try opens up.
    expect(miss(ip(99), T0 + 24 * 60 * MIN)).toBeNull();
  });

  it("doesn't count right PINs towards the daily cap", () => {
    for (let n = 0; n < 30; n++) {
      const a = auth.claimLoginAttempt(ip(n), T0);
      if ("retryAfter" in a) throw new Error("should not be locked");
      a.settle(n % 2 ? "owner" : "partner");
    }
    expect(miss(ip(99), T0)).toBeNull();
  });

  it("asks for one owner alert when the daily cap closes, not one per miss", () => {
    const alerts: boolean[] = [];
    for (let n = 0; n < 20; n++) {
      const a = auth.claimLoginAttempt(ip(n), T0 + n);
      if ("settle" in a) alerts.push(a.settle(null));
    }
    expect(alerts.filter(Boolean)).toHaveLength(1);
    expect(alerts[19]).toBe(true);
    // Later trips the same day stay quiet.
    const later = auth.claimLoginAttempt(ip(50), T0 + 24 * 60 * MIN);
    expect("settle" in later && later.settle(null)).toBe(false);
  });
});

describe("loginClient", () => {
  it("keys strangers by X-Real-IP, else the leftmost forwarded entry", () => {
    expect(auth.loginClient(undefined, "203.0.113.9, 100.64.0.2", "198.51.100.7")).toEqual({
      key: "ip:198.51.100.7",
      trusted: false,
    });
    expect(auth.loginClient(undefined, "203.0.113.9, 100.64.0.2").key).toBe("ip:203.0.113.9");
    expect(auth.loginClient(undefined, null).trusted).toBe(false);
  });

  it("recognises an owner-device cookie it minted, and nothing else", () => {
    const cookie = auth.mintOwnerDeviceCookie();
    const client = auth.loginClient(cookie, "203.0.113.9");
    expect(client.trusted).toBe(true);
    expect(client.key).toMatch(/^device:/);

    const [id, , sig] = cookie.split(".");
    expect(auth.loginClient(`${id}.partner.${sig}`, "1.2.3.4").trusted).toBe(false);
    expect(auth.loginClient(`${id}.owner.${"0".repeat(64)}`, "1.2.3.4").trusted).toBe(false);
    expect(auth.loginClient(`${id}.${sig}`, "1.2.3.4").trusted).toBe(false);
    expect(auth.loginClient("junk", "1.2.3.4").trusted).toBe(false);
  });

  it("keeps the owner's devices known across PIN changes", () => {
    const cookie = auth.mintOwnerDeviceCookie();
    settingsRepo.updateApp({ pinHash: auth.hashPin("9999"), joint: { partnerPinHash: auth.hashPin("2468") } });
    expect(auth.loginClient(cookie, "1.2.3.4").trusted).toBe(true);
  });
});

describe("sessions", () => {
  beforeEach(() => {
    getDb().prepare("DELETE FROM sessions").run();
    getDb().prepare("DELETE FROM push_subscriptions").run();
  });

  it("stops honouring a session once it outlives the cookie", () => {
    const token = sessionsRepo.create("ua", "owner");
    expect(sessionsRepo.verify(token)).toBe(true);
    const old = new Date(Date.now() - sessionsRepo.maxAgeMs - MIN).toISOString();
    getDb().prepare("UPDATE sessions SET created_at=? WHERE token=?").run(old, token);
    expect(sessionsRepo.verify(token)).toBe(false);
    expect(sessionsRepo.roleOf(token)).toBeNull();
  });

  it("ends one role's sessions except the caller's", () => {
    const mine = sessionsRepo.create("ua", "owner");
    const other = sessionsRepo.create("ua", "owner");
    const partner = sessionsRepo.create("ua", "partner");
    sessionsRepo.destroyRole("owner", mine);
    expect(sessionsRepo.verify(mine)).toBe(true);
    expect(sessionsRepo.verify(other)).toBe(false);
    expect(sessionsRepo.verify(partner)).toBe(true);
  });
});

describe("push subscriptions follow sessions", () => {
  const sub = (n: number) => ({
    endpoint: `https://push.example/${n}`,
    keys: { p256dh: `p${n}`, auth: `a${n}` },
  });

  beforeEach(() => {
    getDb().prepare("DELETE FROM sessions").run();
    getDb().prepare("DELETE FROM push_subscriptions").run();
  });

  it("never hands the session link to senders", () => {
    const token = sessionsRepo.create("ua", "owner");
    pushRepo.add(sub(1), "owner", token);
    const [row] = pushRepo.list();
    expect(row.subscription).toEqual(sub(1));
    const raw = getDb().prepare("SELECT subscription FROM push_subscriptions").get() as {
      subscription: string;
    };
    expect(raw.subscription).not.toContain(token);
  });

  it("drops the devices of ended sessions and keeps the rest", () => {
    const owner = sessionsRepo.create("ua", "owner");
    const leaving = sessionsRepo.create("ua", "owner");
    pushRepo.add(sub(1), "owner", owner);
    pushRepo.add(sub(2), "owner", leaving);
    pushRepo.add(sub(3), "owner"); // saved before the link existed
    sessionsRepo.destroy(leaving);
    pushRepo.pruneSignedOut();
    expect(pushRepo.list().map((r) => r.endpoint).sort()).toEqual([
      sub(1).endpoint,
      sub(3).endpoint,
    ]);
  });

  it("moves a device to whoever posts it next", () => {
    const owner = sessionsRepo.create("ua", "owner");
    pushRepo.add(sub(1), "owner", owner);
    sessionsRepo.destroy(owner);
    const partner = sessionsRepo.create("ua", "partner");
    pushRepo.add(sub(1), "partner", partner);
    pushRepo.pruneSignedOut();
    expect(pushRepo.list(["owner"])).toHaveLength(0);
    expect(pushRepo.list(["partner"])).toHaveLength(1);
  });

  it("revoking the partner stops her pushes", () => {
    const partner = sessionsRepo.create("ua", "partner");
    const owner = sessionsRepo.create("ua", "owner");
    pushRepo.add(sub(1), "partner", partner);
    pushRepo.add(sub(2), "partner"); // unlinked
    pushRepo.add(sub(3), "owner", owner);
    sessionsRepo.destroyRole("partner");
    pushRepo.pruneSignedOut();
    expect(pushRepo.list(["partner"]).map((r) => r.endpoint)).toEqual([sub(2).endpoint]);
    pushRepo.removeRole("partner");
    expect(pushRepo.list().map((r) => r.endpoint)).toEqual([sub(3).endpoint]);
  });
});

describe("the owner's devices", () => {
  const LAPTOP = "203.0.113.5";
  const DAY = 24 * 60 * MIN;

  /** Someone elsewhere spends the shared 20-a-day budget. */
  function strangersFillTheCap(now: number) {
    for (let i = 0; i < 20; i++) miss({ key: `ip:198.51.100.${i}`, trusted: false }, now);
  }

  beforeEach(() => {
    auth.__resetLoginLimiterForTests();
    jar.clear();
    deviceSets.length = 0;
  });

  it("stays known after the owner signs out", async () => {
    await auth.createSession("owner");
    await auth.destroySession();
    strangersFillTheCap(T0);
    const a = auth.claimLoginAttempt(auth.loginClient(jar.get(auth.DEVICE_COOKIE), LAPTOP), T0 + MIN);
    expect("settle" in a).toBe(true);
  });

  it("stays known after the partner signs in on it once", async () => {
    await auth.createSession("owner");
    await auth.destroySession();
    await auth.createSession("partner");
    await auth.destroySession();
    strangersFillTheCap(T0);
    const a = auth.claimLoginAttempt(auth.loginClient(jar.get(auth.DEVICE_COOKIE), LAPTOP), T0 + MIN);
    expect("settle" in a).toBe(true);
  });

  it("is never made by a partner sign-in", async () => {
    await auth.createSession("partner");
    expect(jar.get(auth.DEVICE_COOKIE)).toBeUndefined();
  });

  it("re-dates its mark once a month old, keeping the id", async () => {
    await auth.rememberOwnerDevice(T0);
    await auth.rememberOwnerDevice(T0 + 29 * DAY);
    expect(deviceSets).toHaveLength(1);
    await auth.rememberOwnerDevice(T0 + 31 * DAY);
    expect(deviceSets).toHaveLength(2);
    expect(deviceSets[1].maxAge).toBe(Math.floor(sessionsRepo.maxAgeMs / 1000));
    const [first, second] = deviceSets.map((s) => auth.loginClient(s.value, LAPTOP).key);
    expect(second).toBe(first);
  });

  it("still accepts the older undated cookie, and re-dates it", async () => {
    auth.mintOwnerDeviceCookie(); // makes the secret if this run has none yet
    const secret = settingsRepo.getKV("auth.deviceSecret")!;
    const id = "a".repeat(32);
    const sig = crypto.createHmac("sha256", secret).update(`${id}.owner`).digest("hex");
    const legacy = `${id}.owner.${sig}`;
    expect(auth.loginClient(legacy, LAPTOP)).toEqual({ key: `device:${id}`, trusted: true });

    jar.set(auth.DEVICE_COOKIE, legacy);
    await auth.rememberOwnerDevice(T0);
    expect(deviceSets).toHaveLength(1);
    expect(auth.loginClient(deviceSets[0].value, LAPTOP).key).toBe(`device:${id}`);
  });
});

describe("one PIN for both people (left over from before the check)", () => {
  const SHARED = "4242";

  async function signIn(cookie?: string) {
    const req = new NextRequest("http://localhost/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ pin: SHARED }),
      headers: {
        "content-type": "application/json",
        "x-real-ip": "203.0.113.77",
        ...(cookie ? { cookie: `${auth.DEVICE_COOKIE}=${cookie}` } : {}),
      },
    });
    const res = await login.POST(req);
    return { status: res.status, body: (await res.json()) as { role?: string } };
  }

  beforeEach(() => {
    auth.__resetLoginLimiterForTests();
    jar.clear();
    settingsRepo.updateApp({ pinHash: auth.hashPin(SHARED), joint: { partnerPinHash: auth.hashPin(SHARED) } });
  });

  it("signs in as the owner on one of the owner's devices", async () => {
    const res = await signIn(auth.mintOwnerDeviceCookie());
    expect(res).toEqual({ status: 200, body: { ok: true, role: "owner" } });
  });

  it("refuses anywhere else, and leaves the owner a note to fix it", async () => {
    expect(auth.pinsCollide()).toBe(false);
    expect((await signIn()).status).toBe(401);
    expect(auth.pinsCollide()).toBe(true);
  });

  it("drops the note once either PIN changes", async () => {
    await signIn();
    settingsRepo.updateApp({ pinHash: auth.hashPin("9090") });
    expect(auth.pinsCollide()).toBe(false);
  });
});

describe("forgetting a signed-out browser's pushes", () => {
  const post = (body: unknown) =>
    forget.POST(
      new NextRequest("http://localhost/api/push/forget", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    );

  beforeEach(() => {
    getDb().prepare("DELETE FROM push_subscriptions").run();
  });

  it("removes that endpoint's row only, with no session", async () => {
    pushRepo.add({ endpoint: "https://push.example/a", keys: { p256dh: "p", auth: "a" } }, "owner");
    pushRepo.add({ endpoint: "https://push.example/b", keys: { p256dh: "p", auth: "a" } }, "owner");
    expect((await post({ endpoint: "https://push.example/a" })).status).toBe(200);
    expect(pushRepo.list().map((r) => r.endpoint)).toEqual(["https://push.example/b"]);
  });

  it("turns away anything that isn't a push endpoint", async () => {
    expect((await post({ endpoint: "not a url" })).status).toBe(400);
    expect((await post({ endpoint: "http://push.example/a" })).status).toBe(400);
    expect((await post({ endpoint: `https://push.example/${"x".repeat(3000)}` })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });
});
