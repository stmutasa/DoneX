import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
