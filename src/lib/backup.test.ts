import fs from "fs";
import os from "os";
import path from "path";
import zlib from "zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// A throwaway data directory per run, so the real one is never touched.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "donex-backup-"));
process.env.DATA_DIR = DIR;

const backup = await import("@/lib/backup");
const { getDb } = await import("@/lib/db");
const { tasksRepo, notesRepo, settingsRepo } = await import("@/lib/db/repos");

beforeAll(() => {
  settingsRepo.updateApp({ tz: "America/New_York" });
  tasksRepo.create({ title: "first task" });
  tasksRepo.create({ title: "second task" });
  notesRepo.create({ title: "a note", kind: "note", content: "keep me" });
});

afterAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("snapshots", () => {
  it("captures the tables that matter and counts them", () => {
    const { manifest } = backup.buildSnapshot("manual");
    expect(manifest.version).toBe(2);
    expect(manifest.counts.tasks).toBe(2);
    expect(manifest.counts.notes).toBe(1);
    expect(manifest.counts.settings).toBeGreaterThan(0);
  });

  it("leaves sessions and push subscriptions out — those belong to devices", () => {
    const { manifest } = backup.buildSnapshot("manual");
    expect(manifest.counts.sessions).toBeUndefined();
    expect(manifest.counts.push_subscriptions).toBeUndefined();
  });

  it("writes a file that reads back with every row intact", () => {
    const snap = backup.writeSnapshot("manual");
    expect(snap.bytes).toBeGreaterThan(0);
    expect(snap.counts.tasks).toBe(2);
    expect(fs.existsSync(path.join(backup.backupDir(), snap.name))).toBe(true);

    const listed = backup.listSnapshots().find((s) => s.name === snap.name);
    expect(listed?.counts.tasks).toBe(2);
    expect(listed?.kind).toBe("manual");
  });

  it("lists newest first", () => {
    const names = backup.listSnapshots().map((s) => s.createdAt);
    expect([...names].sort((a, b) => b.localeCompare(a))).toEqual(names);
  });
});

describe("restore", () => {
  it("brings back rows deleted since the snapshot, and can be undone", () => {
    const snap = backup.writeSnapshot("manual");

    getDb().prepare("DELETE FROM tasks").run();
    expect(tasksRepo.list({ view: "all" }).length).toBe(0);

    const result = backup.restoreSnapshot(snap.name, false);
    expect(result.restored.tasks).toBe(2);
    expect(tasksRepo.list({ view: "all" }).map((t) => t.title).sort()).toEqual([
      "first task",
      "second task",
    ]);
    // the safety copy means the restore itself is reversible
    expect(backup.listSnapshots().some((s) => s.name === result.safetyCopy)).toBe(true);
  });

  it("drops rows added after the snapshot, rather than merging them in", () => {
    const snap = backup.writeSnapshot("manual");
    tasksRepo.create({ title: "added later" });
    expect(tasksRepo.list({ view: "all" }).length).toBe(3);

    backup.restoreSnapshot(snap.name, false);
    const titles = tasksRepo.list({ view: "all" }).map((t) => t.title);
    expect(titles).not.toContain("added later");
    expect(titles.length).toBe(2);
  });

  it("leaves settings alone unless you ask for them", () => {
    const snap = backup.writeSnapshot("manual");
    settingsRepo.updateApp({ tz: "Europe/Lisbon" });

    backup.restoreSnapshot(snap.name, false);
    expect(settingsRepo.getApp().tz).toBe("Europe/Lisbon");

    backup.restoreSnapshot(snap.name, true);
    expect(settingsRepo.getApp().tz).toBe("America/New_York");
  });

  it("refuses a name that tries to climb out of the backup folder", () => {
    expect(() => backup.readSnapshot("../../etc/passwd")).toThrow();
    expect(() => backup.deleteSnapshot("../secrets.json.gz")).toThrow();
  });

  it("refuses a file that isn't a snapshot", () => {
    const stray = path.join(backup.backupDir(), "not-a-snapshot.json.gz");
    fs.writeFileSync(stray, Buffer.from("nonsense"));
    expect(() => backup.restoreSnapshot("not-a-snapshot.json.gz", false)).toThrow();
    // it is still listed, marked for what it is, rather than hidden
    expect(backup.listSnapshots().find((s) => s.name === "not-a-snapshot.json.gz")?.kind).toBe(
      "unreadable",
    );
    fs.unlinkSync(stray);
  });
});

describe("retention", () => {
  it("keeps a window of each kind instead of a flat total", () => {
    for (let i = 0; i < 12; i++) backup.writeSnapshot("weekly");
    const weekly = backup.listSnapshots().filter((s) => s.kind === "weekly");
    expect(weekly.length).toBeLessThanOrEqual(8);
    // manual snapshots are not evicted by a run of weekly ones
    expect(backup.listSnapshots().some((s) => s.kind === "manual")).toBe(true);
  });
});

describe("status", () => {
  it("remembers the last good run", () => {
    backup.runBackup("manual");
    const status = backup.readStatus();
    expect(status.lastOk).toBe(true);
    expect(status.lastBytes).toBeGreaterThan(0);
    expect(backup.daysSinceBackup(status)).toBe(0);
  });

  it("has no age to report when a backup has never worked", () => {
    expect(
      backup.daysSinceBackup({ lastAt: null, lastOk: false, lastError: null, lastBytes: 0 }),
    ).toBeNull();
  });

  it("counts the days since the last one", () => {
    const eleven = new Date(Date.now() - 11 * 86_400_000).toISOString();
    expect(
      backup.daysSinceBackup({ lastAt: eleven, lastOk: true, lastError: null, lastBytes: 10 }),
    ).toBe(11);
  });
});

describe("restore safety", () => {
  const titles = () =>
    tasksRepo
      .list({ view: "all" })
      .map((t) => t.title)
      .sort();
  const kept = (kind: string) => backup.listSnapshots().filter((s) => s.kind === kind);
  const writeRaw = (name: string, body: unknown) =>
    fs.writeFileSync(
      path.join(backup.backupDir(), name),
      zlib.gzipSync(Buffer.from(JSON.stringify(body), "utf8")),
    );
  const readRaw = (name: string) =>
    JSON.parse(zlib.gunzipSync(backup.readSnapshot(name)).toString("utf8")) as {
      data: Record<string, Record<string, unknown>[]>;
    };

  it("gives two snapshots taken in the same second different names", () => {
    const a = backup.writeSnapshot("manual");
    const b = backup.writeSnapshot("manual");
    expect(a.name).not.toBe(b.name);
    expect(fs.existsSync(path.join(backup.backupDir(), a.name))).toBe(true);
    expect(fs.existsSync(path.join(backup.backupDir(), b.name))).toBe(true);
  });

  it("undoes a restore with its safety copy straight away, without losing anything", () => {
    const before = backup.writeSnapshot("manual");
    tasksRepo.create({ title: "made after the snapshot" });
    const current = titles();

    const first = backup.restoreSnapshot(before.name, false);
    expect(titles()).not.toContain("made after the snapshot");

    // Seconds later: undo it.
    const second = backup.restoreSnapshot(first.safetyCopy, false);
    expect(second.safetyCopy).not.toBe(first.safetyCopy);
    expect(titles()).toEqual(current);
    expect(backup.listSnapshots().some((s) => s.name === first.safetyCopy)).toBe(true);
  });

  it("restores the oldest safety copy kept without pruning it or any other undo point", () => {
    const base = backup.writeSnapshot("manual");
    for (let i = 0; i < 3; i++) backup.restoreSnapshot(base.name, false);
    const safety = kept("pre-restore");
    expect(safety.length).toBeGreaterThanOrEqual(3);
    const oldest = safety[safety.length - 1];

    expect(() => backup.restoreSnapshot(oldest.name, false)).not.toThrow();
    const names = new Set(backup.listSnapshots().map((s) => s.name));
    for (const s of safety) expect(names.has(s.name)).toBe(true);
  });

  it("leaves everything as it was when a restore fails part way", () => {
    writeRaw("donex-broken-rows.json.gz", {
      app: "DoneX",
      version: 2,
      createdAt: new Date().toISOString(),
      kind: "manual",
      counts: {},
      data: { tasks: [{ id: "no-title" }] },
    });
    const names = backup.listSnapshots().map((s) => s.name);
    const current = titles();

    expect(() => backup.restoreSnapshot("donex-broken-rows.json.gz", false)).toThrow(
      /Could not restore tasks/,
    );
    expect(titles()).toEqual(current);
    // no stray safety copy left behind to push a real undo point out
    expect(backup.listSnapshots().map((s) => s.name)).toEqual(names);
    backup.deleteSnapshot("donex-broken-rows.json.gz");
  });

  it("drops columns this build doesn't have instead of failing", () => {
    const snap = backup.writeSnapshot("manual");
    const parsed = readRaw(snap.name);
    parsed.data.tasks = parsed.data.tasks.map((row) => ({ ...row, from_a_newer_build: 1 }));
    writeRaw("donex-newer-build.json.gz", parsed);
    const current = titles();

    const result = backup.restoreSnapshot("donex-newer-build.json.gz", false);
    expect(result.restored.tasks).toBe(current.length);
    expect(titles()).toEqual(current);
    backup.deleteSnapshot("donex-newer-build.json.gz");
  });

  it("keeps this box's scheduler state when settings come back", () => {
    settingsRepo.setKV("sched.lastBriefingDay", "2026-10-20");
    const snap = backup.writeSnapshot("manual");
    settingsRepo.setKV("sched.lastBriefingDay", "2026-10-27");
    settingsRepo.updateApp({ tz: "Europe/Lisbon" });

    backup.restoreSnapshot(snap.name, true);
    expect(settingsRepo.getApp().tz).toBe("America/New_York");
    // An older "last sent" would let this morning's briefing go out twice.
    expect(settingsRepo.getKV("sched.lastBriefingDay")).toBe("2026-10-27");
  });

  it("merges that state key by key, keeping the snapshot's for keys this box lacks", () => {
    // Moving to a new box: the old one had sent today's digest; the new one
    // has only run a triage slot so far.
    settingsRepo.setKV("sched.lastJointDigest.owner", "2026-10-27");
    const snap = backup.writeSnapshot("manual");
    getDb().prepare("DELETE FROM settings WHERE key = 'sched.lastJointDigest.owner'").run();
    settingsRepo.setKV("sched.lastTriageSlot", "2026-10-27@06:00");

    backup.restoreSnapshot(snap.name, true);
    expect(settingsRepo.getKV("sched.lastJointDigest.owner")).toBe("2026-10-27");
    expect(settingsRepo.getKV("sched.lastTriageSlot")).toBe("2026-10-27@06:00");
  });

  it("keeps the owner's devices signed in across a settings restore", async () => {
    const auth = await import("@/lib/auth");
    // A snapshot from before there was a device secret.
    getDb().prepare("DELETE FROM settings WHERE key = 'auth.deviceSecret'").run();
    const old = backup.writeSnapshot("manual");

    // Then the owner's phone gets its device cookie, which makes the secret.
    const phone = auth.mintOwnerDeviceCookie();
    const secret = settingsRepo.getKV("auth.deviceSecret");
    expect(secret).toBeTruthy();
    expect(auth.loginClient(phone, null).trusted).toBe(true);

    backup.restoreSnapshot(old.name, true);
    expect(settingsRepo.getKV("auth.deviceSecret")).toBe(secret);
    expect(auth.loginClient(phone, null).trusted).toBe(true);
  });

  it("takes the snapshot's device secret when this box has none", () => {
    settingsRepo.setKV("auth.deviceSecret", "from-the-old-box");
    const snap = backup.writeSnapshot("manual");
    getDb().prepare("DELETE FROM settings WHERE key = 'auth.deviceSecret'").run();

    backup.restoreSnapshot(snap.name, true);
    expect(settingsRepo.getKV("auth.deviceSecret")).toBe("from-the-old-box");
  });

  it("keeps this box's push key pair, which its kept subscriptions were made for", async () => {
    const { ensureVapid } = await import("@/lib/push");
    const { pushRepo } = await import("@/lib/db/repos");
    settingsRepo.updateApp({ vapid: null });
    // An early snapshot, from before notifications were ever turned on.
    const early = backup.writeSnapshot("weekly");
    const live = ensureVapid();
    pushRepo.add({ endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } }, "owner");

    backup.restoreSnapshot(early.name, true);
    expect(pushRepo.list().map((r) => r.endpoint)).toContain("https://push.example/abc");
    expect(settingsRepo.getApp().vapid).toEqual(live);
  });

  it("takes the snapshot's push key pair when this box has none", () => {
    const pair = { publicKey: "pub-from-snapshot", privateKey: "priv-from-snapshot" };
    settingsRepo.updateApp({ vapid: pair });
    const snap = backup.writeSnapshot("manual");
    settingsRepo.updateApp({ vapid: null });

    backup.restoreSnapshot(snap.name, true);
    expect(settingsRepo.getApp().vapid).toEqual(pair);
  });

  it("puts an older snapshot's subtasks back on their parent's list", () => {
    const parent = tasksRepo.create({ title: "plan the party", space: "joint" });
    const child = tasksRepo.create({ title: "order the cake", parentId: parent.id, space: "joint" });
    const snap = backup.writeSnapshot("manual");
    const parsed = readRaw(snap.name);
    parsed.data.tasks = parsed.data.tasks.map((row) =>
      row.id === child.id ? { ...row, space: "personal" } : row,
    );
    writeRaw("donex-old-subtasks.json.gz", parsed);

    backup.restoreSnapshot("donex-old-subtasks.json.gz", false);
    expect(tasksRepo.get(child.id)?.space).toBe("joint");
    backup.deleteSnapshot("donex-old-subtasks.json.gz");
  });
});

describe("snapshot names", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("puts the owner's local date and time in the name, not the server's", () => {
    // Sunday 9:00 PM EDT is already 01:00 Monday in UTC.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T01:00:05Z"));
    const snap = backup.writeSnapshot("manual");
    vi.useRealTimers();

    expect(snap.name).toMatch(/^donex-2026-10-25-210005-[0-9a-f]{4}-manual\.json\.gz$/);
    backup.deleteSnapshot(snap.name);
  });
});
