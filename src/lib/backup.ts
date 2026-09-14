/**
 * Snapshots of everything, kept on the data volume and restorable in a tap.
 *
 * The app lives on one volume, so the point of this is twofold: undo a bad
 * import or a regretted bulk change, and give you something concrete to pull
 * off the box each week. A snapshot is only reported as good once it has been
 * read back and parsed — a backup nobody has verified is a rumour.
 */
import "server-only";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { getDb } from "@/lib/db";
import { settingsRepo } from "@/lib/db/repos";
import { localDateKey, nowIso } from "@/lib/utils";

/** Everything worth carrying forward. Sessions and push subscriptions are
 *  deliberately left out: they belong to devices, not to your data. */
const TABLES = [
  "settings",
  "projects",
  "tasks",
  "completions",
  "notes",
  "inbox_items",
  "briefings",
  "reviews",
  "conversations",
  "messages",
  "triage_feedback",
  "google_tokens",
  "ai_usage",
] as const;

/** Tables a "data only" restore touches — settings and tokens stay put. */
const DATA_TABLES = TABLES.filter(
  (t) => t !== "settings" && t !== "google_tokens",
);

export interface SnapshotManifest {
  app: "DoneX";
  version: 2;
  createdAt: string;
  /** "weekly" | "manual" | "pre-restore" */
  kind: string;
  counts: Record<string, number>;
}

export interface SnapshotFile {
  name: string;
  createdAt: string;
  kind: string;
  bytes: number;
  counts: Record<string, number>;
}

export interface BackupStatus {
  lastAt: string | null;
  lastOk: boolean;
  lastError: string | null;
  lastBytes: number;
}

const KV_STATUS = "backup.status";
const KEEP_PER_KIND: Record<string, number> = { weekly: 8, manual: 3, "pre-restore": 3 };

export function backupDir(): string {
  const dir = path.join(process.env.DATA_DIR || path.join(process.cwd(), "data"), "backups");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readTable(table: string): Record<string, unknown>[] {
  try {
    return getDb().prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  } catch {
    // A table from a newer or older build than this one — skip it rather than
    // losing the whole snapshot over it.
    return [];
  }
}

export function buildSnapshot(kind: string): { manifest: SnapshotManifest; body: string } {
  const data: Record<string, unknown> = {};
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const rows = readTable(table);
    data[table] = rows;
    counts[table] = rows.length;
  }
  const manifest: SnapshotManifest = {
    app: "DoneX",
    version: 2,
    createdAt: nowIso(),
    kind,
    counts,
  };
  return { manifest, body: JSON.stringify({ ...manifest, data }) };
}

function fileNameFor(kind: string, at: Date, tz: string): string {
  const date = localDateKey(at, tz);
  const time = `${String(at.getHours()).padStart(2, "0")}${String(at.getMinutes()).padStart(2, "0")}`;
  return `donex-${date}-${time}-${kind}.json.gz`;
}

/** Write a snapshot, read it back, and only then call it done. */
export function writeSnapshot(kind: string): SnapshotFile {
  const tz = settingsRepo.getApp().tz;
  const { manifest, body } = buildSnapshot(kind);
  const name = fileNameFor(kind, new Date(), tz);
  const full = path.join(backupDir(), name);

  fs.writeFileSync(full, zlib.gzipSync(Buffer.from(body, "utf8")));

  // Verify: unzip, parse, and check the row counts survived the round trip.
  const roundTrip = JSON.parse(zlib.gunzipSync(fs.readFileSync(full)).toString("utf8")) as {
    counts?: Record<string, number>;
    data?: Record<string, unknown[]>;
  };
  for (const [table, count] of Object.entries(manifest.counts)) {
    const got = roundTrip.data?.[table]?.length ?? -1;
    if (got !== count) {
      fs.unlinkSync(full);
      throw new Error(`Snapshot failed its own check on ${table} (${got} of ${count} rows)`);
    }
  }

  pruneSnapshots();
  return {
    name,
    createdAt: manifest.createdAt,
    kind,
    bytes: fs.statSync(full).size,
    counts: manifest.counts,
  };
}

/** Newest first. Unreadable files are listed rather than hidden. */
export function listSnapshots(): SnapshotFile[] {
  const dir = backupDir();
  const out: SnapshotFile[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json.gz")) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      const parsed = JSON.parse(zlib.gunzipSync(fs.readFileSync(full)).toString("utf8")) as
        SnapshotManifest;
      out.push({
        name,
        createdAt: parsed.createdAt ?? stat.mtime.toISOString(),
        kind: parsed.kind ?? "manual",
        bytes: stat.size,
        counts: parsed.counts ?? {},
      });
    } catch {
      out.push({
        name,
        createdAt: fs.statSync(full).mtime.toISOString(),
        kind: "unreadable",
        bytes: fs.statSync(full).size,
        counts: {},
      });
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Keep a useful window of each kind rather than a fixed total. */
export function pruneSnapshots(): number {
  const byKind = new Map<string, SnapshotFile[]>();
  for (const snap of listSnapshots()) {
    byKind.set(snap.kind, [...(byKind.get(snap.kind) ?? []), snap]);
  }
  let removed = 0;
  for (const [kind, snaps] of byKind) {
    const keep = KEEP_PER_KIND[kind] ?? 3;
    for (const snap of snaps.slice(keep)) {
      try {
        fs.unlinkSync(path.join(backupDir(), snap.name));
        removed++;
      } catch {
        // a file that has already gone is not a problem
      }
    }
  }
  return removed;
}

export function readSnapshot(name: string): Buffer {
  // Names come from the listing; refuse anything that tries to leave the dir.
  if (!/^[A-Za-z0-9._-]+\.json\.gz$/.test(name)) throw new Error("Unknown snapshot");
  const full = path.join(backupDir(), name);
  if (!fs.existsSync(full)) throw new Error("Unknown snapshot");
  return fs.readFileSync(full);
}

export function deleteSnapshot(name: string): void {
  if (!/^[A-Za-z0-9._-]+\.json\.gz$/.test(name)) throw new Error("Unknown snapshot");
  const full = path.join(backupDir(), name);
  if (fs.existsSync(full)) fs.unlinkSync(full);
}

export interface RestoreResult {
  restored: Record<string, number>;
  safetyCopy: string;
}

/**
 * Put a snapshot back. Everything is replaced table by table inside one
 * transaction, and a "pre-restore" snapshot is taken first so a restore is
 * itself undoable. `includeSettings` also brings back your configuration and
 * Google connection — powerful, and not what you want when you are only
 * undoing a bad import.
 */
export function restoreSnapshot(name: string, includeSettings: boolean): RestoreResult {
  const safety = writeSnapshot("pre-restore");

  const parsed = JSON.parse(zlib.gunzipSync(readSnapshot(name)).toString("utf8")) as {
    version?: number;
    data?: Record<string, Record<string, unknown>[]>;
  };
  if (!parsed.data) throw new Error("That file is not a DoneX snapshot");

  const db = getDb();
  const tables = includeSettings ? [...TABLES] : [...DATA_TABLES];
  const restored: Record<string, number> = {};

  const run = db.transaction(() => {
    for (const table of tables) {
      const rows = parsed.data?.[table];
      if (!Array.isArray(rows)) continue;
      try {
        db.prepare(`DELETE FROM ${table}`).run();
        for (const row of rows) {
          const cols = Object.keys(row);
          if (cols.length === 0) continue;
          db.prepare(
            `INSERT OR REPLACE INTO ${table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`,
          ).run(...cols.map((c) => row[c] as never));
        }
        restored[table] = rows.length;
      } catch (err) {
        throw new Error(`Could not restore ${table}: ${(err as Error).message}`);
      }
    }
  });
  run();

  return { restored, safetyCopy: safety.name };
}

export function readStatus(): BackupStatus {
  try {
    const raw = settingsRepo.getKV(KV_STATUS);
    if (raw) return JSON.parse(raw) as BackupStatus;
  } catch {
    // fall through to the empty status
  }
  return { lastAt: null, lastOk: false, lastError: null, lastBytes: 0 };
}

export function writeStatus(status: BackupStatus): void {
  try {
    settingsRepo.setKV(KV_STATUS, JSON.stringify(status));
  } catch {
    // status is a nicety; never fail a backup over it
  }
}

/** Take a snapshot and remember how it went, for the Settings screen. */
export function runBackup(kind: string): SnapshotFile {
  try {
    const snap = writeSnapshot(kind);
    writeStatus({ lastAt: snap.createdAt, lastOk: true, lastError: null, lastBytes: snap.bytes });
    return snap;
  } catch (err) {
    writeStatus({
      lastAt: nowIso(),
      lastOk: false,
      lastError: (err as Error).message.slice(0, 300),
      lastBytes: 0,
    });
    throw err;
  }
}

/** Days since the last good backup, or null when there has never been one. */
export function daysSinceBackup(status: BackupStatus, now = new Date()): number | null {
  if (!status.lastAt || !status.lastOk) return null;
  const ms = now.getTime() - Date.parse(status.lastAt);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null;
}
