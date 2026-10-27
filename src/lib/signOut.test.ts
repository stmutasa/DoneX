import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let left = 0;

vi.mock("@/lib/api", () => ({
  authApi: {
    logout: vi.fn(async () => {
      calls.push("logout");
    }),
  },
}));
vi.mock("@/lib/offline", () => ({
  flushOutboxBeforeSignOut: vi.fn(async () => {
    calls.push("flush");
    return left;
  }),
  clearLocalDataOnSignOut: vi.fn(async () => {
    calls.push("clear");
  }),
}));
vi.mock("@/lib/pushClient", () => ({
  forgetPushOnServer: vi.fn(async () => {
    calls.push("forget-push");
  }),
}));

const replace = vi.fn((url: string) => calls.push(`go ${url}`));
vi.stubGlobal("window", { location: { replace } });

const { signOutThisDevice, UnsyncedChangesError } = await import("@/lib/signOut");

describe("signOutThisDevice", () => {
  beforeEach(() => {
    calls.length = 0;
    left = 0;
  });

  it("lands the queue, then ends the session, then forgets the device", async () => {
    await signOutThisDevice();
    expect(calls).toEqual(["flush", "logout", "forget-push", "clear", "go /login"]);
  });

  it("stops before anything ends when changes couldn't sync", async () => {
    left = 2;
    const err = await signOutThisDevice().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsyncedChangesError);
    expect((err as InstanceType<typeof UnsyncedChangesError>).count).toBe(2);
    expect((err as Error).message).toBe("2 changes haven’t synced yet. Sign out anyway and lose them?");
    expect(calls).toEqual(["flush"]);
  });

  it("goes ahead once the person says to lose them", async () => {
    left = 1;
    await signOutThisDevice({ discardUnsynced: true });
    expect(calls).toEqual(["flush", "logout", "forget-push", "clear", "go /login"]);
  });

  it("keeps everything when the logout fails", async () => {
    const { authApi } = await import("@/lib/api");
    vi.mocked(authApi.logout).mockRejectedValueOnce(new Error("You’re offline"));
    await expect(signOutThisDevice()).rejects.toThrow("You’re offline");
    expect(calls).toEqual(["flush"]);
  });
});
