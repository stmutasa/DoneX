import { alignSubtaskSpaces, getDb } from "@/lib/db";
import { newId, nowIso, localDateKey, localTimeKey, addDaysToDateKey, isoFromLocal } from "@/lib/utils";
import { effectivePriority } from "@/lib/deadline";
import { anchorRule, nextOccurrence } from "@/lib/recurrence";
import type {
  AppSettings,
  Conversation,
  ChatMessageRecord,
  ChatRole,
  InboxItem,
  InboxSource,
  InboxStatus,
  InboxSuggestion,
  Note,
  Briefing,
  Project,
  RecurrenceRule,
  SessionRole,
  StatsSummary,
  Task,
  TaskDraft,
  TaskListFilter,
  TaskPatch,
  ToolActivity,
  TriageFeedback,
  WeeklyReview,
} from "@/lib/types";
import type { UsageRow } from "@/lib/usage";
import type Database from "better-sqlite3";
import crypto from "crypto";

// ── Settings ───────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: AppSettings = {
  pinHash: "",
  tz: "America/New_York",
  theme: "system",
  ai: {
    provider: "openai",
    model: "",
    openaiModel: "",
    anthropicModel: "",
    geminiModel: "",
    openaiKey: "",
    anthropicKey: "",
    customBaseUrl: "",
    customKey: "",
    customModel: "",
    fallbackProvider: "",
    fallbackModel: "",
    fallbackModelPinned: "",
  },
  voice: { voiceURI: "", rate: 1, autoListen: true },
  features: {
    assistant: false,
    nearby: false,
    walkMode: false,
  },
  notifications: {
    remindersEnabled: true,
    briefingEnabled: true,
    briefingTime: "07:00",
    weeklyReviewEnabled: true,
    weeklyDay: 0,
    weeklyTime: "18:00",
    quietHoursEnabled: true,
    quietStart: "22:00",
    quietEnd: "06:00",
  },
  google: {
    clientId: "",
    clientSecret: "",
    gmailScanEnabled: false,
    gmailQuery: "",
    mapsApiKey: "",
  },
  joint: {
    partnerPinHash: "",
    ownerName: "",
    partnerName: "",
    ownerIcsUrl: "",
    partnerIcsUrl: "",
    partnerGoogleId: "",
    ownerColor: "blue",
    partnerColor: "pink",
    ownerDigestEnabled: true,
    ownerDigestTime: "07:00",
    partnerDigestEnabled: true,
    partnerDigestTime: "10:00",
    ownerWeekAheadEnabled: true,
    ownerWeekAheadTime: "18:00",
    partnerWeekAheadEnabled: true,
    partnerWeekAheadTime: "18:00",
    nudgeEnabled: true,
    nudgeTime: "18:00",
  },
  lastLocation: null,
  ingestToken: "",
  shareToken: "",
  smsCaptureEnabled: true,
  vapid: null,
  onboardedAt: null,
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> | T[K] : T[K] };

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(base) || Array.isArray(patch) || typeof base !== "object" || base === null) {
    return patch as T;
  }
  if (typeof patch !== "object") return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = (base as Record<string, unknown>)[k];
    if (cur !== null && typeof cur === "object" && !Array.isArray(cur) && v !== null && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(cur, v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export const settingsRepo = {
  getApp(): AppSettings {
    const row = getDb().prepare("SELECT value FROM settings WHERE key='app'").get() as
      | { value: string }
      | undefined;
    const stored = row ? (JSON.parse(row.value) as DeepPartial<AppSettings>) : {};
    return deepMerge(structuredClone(DEFAULT_SETTINGS), stored);
  },
  updateApp(patch: DeepPartial<AppSettings>): AppSettings {
    const merged = deepMerge(this.getApp(), patch);
    getDb()
      .prepare(
        "INSERT INTO settings(key,value) VALUES('app',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(JSON.stringify(merged));
    return merged;
  },
  getKV(key: string): string | null {
    const row = getDb().prepare("SELECT value FROM settings WHERE key=?").get(key) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  },
  setKV(key: string, value: string): void {
    getDb()
      .prepare(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(key, value);
  },
};

// ── Sessions ───────────────────────────────────────────────────────────────

export const sessionsRepo = {
  /** The cookie's lifetime, enforced here too, so a copied token stops
   *  working when the cookie it came from would have. */
  maxAgeMs: 400 * 24 * 60 * 60 * 1000,
  /** Oldest created_at a session can have and still count. */
  liveSince(): string {
    return new Date(Date.now() - sessionsRepo.maxAgeMs).toISOString();
  },
  create(userAgent: string, role: "owner" | "partner" = "owner"): string {
    const token = crypto.randomBytes(32).toString("hex");
    getDb()
      .prepare(
        "INSERT INTO sessions(token, created_at, last_seen_at, user_agent, role) VALUES(?,?,?,?,?)"
      )
      .run(token, nowIso(), nowIso(), userAgent.slice(0, 300), role);
    return token;
  },
  /** null = no such session */
  roleOf(token: string): "owner" | "partner" | null {
    if (!token) return null;
    const row = getDb()
      .prepare("SELECT role FROM sessions WHERE token=? AND created_at>=?")
      .get(token, sessionsRepo.liveSince()) as { role: string } | undefined;
    if (!row) return null;
    getDb().prepare("UPDATE sessions SET last_seen_at=? WHERE token=?").run(nowIso(), token);
    return row.role === "partner" ? "partner" : "owner";
  },
  verify(token: string): boolean {
    if (!token) return false;
    const row = getDb()
      .prepare("SELECT token FROM sessions WHERE token=? AND created_at>=?")
      .get(token, sessionsRepo.liveSince());
    if (!row) return false;
    getDb().prepare("UPDATE sessions SET last_seen_at=? WHERE token=?").run(nowIso(), token);
    return true;
  },
  /** Tokens of every session that still counts. */
  liveTokens(): string[] {
    const rows = getDb()
      .prepare("SELECT token FROM sessions WHERE created_at>=?")
      .all(sessionsRepo.liveSince()) as { token: string }[];
    return rows.map((r) => r.token);
  },
  destroy(token: string): void {
    getDb().prepare("DELETE FROM sessions WHERE token=?").run(token);
  },
  /** Ends every session of one role, except (optionally) the caller's own. */
  destroyRole(role: "owner" | "partner", exceptToken = ""): void {
    getDb().prepare("DELETE FROM sessions WHERE role=? AND token<>?").run(role, exceptToken);
  },
  destroyAll(): void {
    getDb().prepare("DELETE FROM sessions").run();
  },
};

// ── Tasks ──────────────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  title: string;
  notes: string;
  status: string;
  space: string;
  created_by: string;
  assigned_to: string | null;
  priority: number;
  due_at: string | null;
  due_kind: string;
  all_day: number;
  project_id: string | null;
  tags: string;
  parent_id: string | null;
  recurrence: string | null;
  location: string | null;
  sort: number;
  notified_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    status: r.status as Task["status"],
    space: r.space === "joint" ? "joint" : "personal",
    createdBy: r.created_by === "partner" ? "partner" : "owner",
    assignedTo: r.assigned_to === "owner" || r.assigned_to === "partner" ? r.assigned_to : null,
    priority: r.priority as Task["priority"],
    dueAt: r.due_at,
    dueKind: r.due_kind === "by" ? "by" : "on",
    allDay: !!r.all_day,
    projectId: r.project_id,
    tags: JSON.parse(r.tags || "[]"),
    parentId: r.parent_id || null,
    recurrence: r.recurrence ? JSON.parse(r.recurrence) : null,
    location: r.location ? JSON.parse(r.location) : null,
    sort: r.sort,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function attachSubtasks(tasks: Task[]): Task[] {
  if (tasks.length === 0) return tasks;
  const ids = tasks.map((t) => t.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT * FROM tasks WHERE parent_id IN (${placeholders}) ORDER BY sort ASC, created_at ASC`
    )
    .all(...ids) as TaskRow[];
  const byParent = new Map<string, Task[]>();
  for (const r of rows) {
    const t = rowToTask(r);
    const list = byParent.get(r.parent_id!) ?? [];
    list.push(t);
    byParent.set(r.parent_id!, list);
  }
  for (const t of tasks) t.subtasks = byParent.get(t.id) ?? [];
  return tasks;
}

const TASK_ORDER =
  "ORDER BY (due_at IS NULL) ASC, due_at ASC, priority DESC, sort ASC, created_at ASC";

/** Done tasks returned beside the open ones when a list asks for both. */
const RECENT_DONE_LIMIT = 100;

/** A LIKE pattern that matches `q` literally; pair it with ESCAPE '\'. */
function likeContains(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Two due values name the same moment (or are both empty). */
function sameMoment(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isNaN(ta) || Number.isNaN(tb) ? a === b : ta === tb;
}

/**
 * Where a repeat goes once it is done: the first occurrence after now, so a
 * task that is several intervals overdue doesn't stay overdue. One with no
 * date yet counts today as done and lands, all-day, on the next matching day.
 * `rule` comes back with its anchor day pinned (see anchorRule), for the
 * caller to store, so a short month never pulls later repeats earlier.
 */
function nextDueAfterDone(
  rule: RecurrenceRule,
  dueAt: string | null,
  allDay: boolean,
  now: Date,
  tz: string
): { dueAt: string; allDay: boolean; rule: RecurrenceRule } {
  if (!dueAt) {
    const today = new Date(isoStartOfLocalDay(localDateKey(now, tz), tz));
    const anchored = anchorRule(rule, today, tz);
    return { dueAt: nextOccurrence(anchored, today, tz).toISOString(), allDay: true, rule: anchored };
  }
  const anchored = anchorRule(rule, new Date(dueAt), tz);
  // The wall-clock time the task is set for, read once and put back on every
  // step: carrying a spring-forward shift from step to step would leave a
  // 02:30 task at 03:30 for good.
  const time = localTimeKey(dueAt, tz);
  const atTime = (d: Date) => new Date(isoFromLocal(localDateKey(d, tz), time, tz));
  const todayKey = localDateKey(now, tz);
  const catchUp = (from: Date): Date => {
    let next = atTime(nextOccurrence(anchored, from, tz));
    for (let i = 0; i < 5000 && next.getTime() <= now.getTime(); i++) {
      const after = atTime(nextOccurrence(anchored, next, tz));
      if (after.getTime() <= next.getTime()) break;
      next = after;
    }
    return next;
  };

  // Daily and weekly repeats far behind skip whole periods first (which keeps
  // every-N phase), so a years-old date costs a few steps, not thousands.
  let from = new Date(dueAt);
  const interval = Math.max(1, Math.round(anchored.interval ?? 1));
  const periodDays = anchored.freq === "daily" ? interval : anchored.freq === "weekly" ? 7 * interval : 0;
  if (periodDays) {
    const dueKey = localDateKey(dueAt, tz);
    const behind = Math.round(
      (Date.parse(`${todayKey}T00:00:00Z`) - Date.parse(`${dueKey}T00:00:00Z`)) / 86_400_000
    );
    const skip = Math.floor(behind / periodDays) - 1;
    if (skip > 0) from = new Date(isoFromLocal(addDaysToDateKey(dueKey, skip * periodDays), time, tz));
  }
  let next = catchUp(from);
  // Still behind (a date so old the walk gave up): carry on from yesterday.
  if (next.getTime() <= now.getTime()) {
    next = catchUp(new Date(isoFromLocal(addDaysToDateKey(todayKey, -1), time, tz)));
  }
  return { dueAt: next.toISOString(), allDay, rule: anchored };
}

export const tasksRepo = {
  get(id: string): Task | null {
    const row = getDb().prepare("SELECT * FROM tasks WHERE id=?").get(id) as TaskRow | undefined;
    if (!row) return null;
    const [task] = attachSubtasks([rowToTask(row)]);
    return task;
  },

  list(filter: TaskListFilter = {}): Task[] {
    const settings = settingsRepo.getApp();
    const tz = settings.tz;
    const todayKey = localDateKey(new Date(), tz);
    const tomorrowStartIso = isoStartOfLocalDay(addDaysToDateKey(todayKey, 1), tz);

    const where: string[] = ["parent_id IS NULL", "space = ?"];
    const params: unknown[] = [filter.space === "joint" ? "joint" : "personal"];

    if (filter.view === "today") {
      // open tasks due before tomorrow (today + overdue), plus live "by"
      // deadlines — those stay on Today every day until their date passes
      if (filter.includeDone) {
        where.push(
          "((status='open' AND due_at IS NOT NULL AND (due_at < ? OR due_kind='by')) OR (status='done' AND completed_at >= ?))"
        );
        params.push(tomorrowStartIso, isoStartOfLocalDay(todayKey, tz));
      } else {
        where.push("status='open' AND due_at IS NOT NULL AND (due_at < ? OR due_kind='by')");
        params.push(tomorrowStartIso);
      }
    } else if (filter.view === "upcoming") {
      where.push("status='open' AND due_at IS NOT NULL AND due_at >= ?");
      params.push(tomorrowStartIso);
    } else if (filter.view === "anytime") {
      where.push("status='open' AND due_at IS NULL");
    }
    // Open and done in one capped query let years of done tasks crowd new
    // open ones out, so a list that wants both gets every open task plus the
    // most recently finished ones.
    const viewSetsStatus =
      filter.view === "today" || filter.view === "upcoming" || filter.view === "anytime";
    const openAndRecentDone = !!filter.includeDone && !viewSetsStatus;
    if (!viewSetsStatus) where.push("status='open'");

    if (filter.projectId) {
      where.push("project_id = ?");
      params.push(filter.projectId);
    } else if (filter.excludeProjects) {
      where.push("project_id IS NULL");
    }
    if (filter.tag) {
      where.push("tags LIKE ? ESCAPE '\\'");
      params.push(likeContains(JSON.stringify(filter.tag)));
    }
    if (filter.q) {
      where.push("(title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')");
      params.push(likeContains(filter.q), likeContains(filter.q));
    }
    if (filter.dueBefore) {
      where.push("due_at IS NOT NULL AND due_at < ?");
      params.push(filter.dueBefore);
    }

    const db = getDb();
    const rows = db
      .prepare(`SELECT * FROM tasks WHERE ${where.join(" AND ")} ${TASK_ORDER} LIMIT 500`)
      .all(...params) as TaskRow[];
    if (openAndRecentDone) {
      const doneWhere = where.map((w) => (w === "status='open'" ? "status='done'" : w));
      // A project's page shows its whole done set and counts it, so only the
      // ever-growing lists (the joint list) are capped.
      const limit = filter.projectId ? "" : `LIMIT ${RECENT_DONE_LIMIT}`;
      rows.push(
        ...(db
          .prepare(
            `SELECT * FROM tasks WHERE ${doneWhere.join(" AND ")}
             ORDER BY completed_at DESC, updated_at DESC ${limit}`
          )
          .all(...params) as TaskRow[])
      );
    }
    const tasks = attachSubtasks(rows.map(rowToTask));
    if (filter.view === "today") {
      // Escalation-aware order: overdue first, then effective priority
      // (deadline tasks climb as their date nears), then due time.
      const startToday = isoStartOfLocalDay(todayKey, tz);
      const rank = (t: Task): number => {
        if (t.status === "done") return -2;
        if (t.dueAt && t.dueAt < startToday) return 4;
        return effectivePriority(t, tz);
      };
      tasks.sort(
        (a, b) =>
          rank(b) - rank(a) ||
          (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") ||
          a.sort - b.sort
      );
    }
    return tasks;
  },

  create(draft: TaskDraft, createdBy: "owner" | "partner" = "owner"): Task {
    const id = newId();
    const now = nowIso();
    // A subtask lives on its parent's list, whatever the caller sent.
    const parentSpace = draft.parentId ? spaceOf(draft.parentId) : null;
    const space = parentSpace ?? (draft.space === "joint" ? "joint" : "personal");
    getDb()
      .prepare(
        `INSERT INTO tasks(id,title,notes,status,space,created_by,assigned_to,priority,due_at,due_kind,all_day,project_id,tags,parent_id,recurrence,location,sort,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        draft.title.trim(),
        draft.notes ?? "",
        "open",
        space,
        createdBy,
        draft.assignedTo === "owner" || draft.assignedTo === "partner" ? draft.assignedTo : null,
        draft.priority ?? 0,
        draft.dueAt ?? null,
        draft.dueKind === "by" ? "by" : "on",
        draft.allDay ? 1 : 0,
        draft.projectId ?? null,
        JSON.stringify(draft.tags ?? []),
        draft.parentId || null,
        draft.recurrence ? JSON.stringify(draft.recurrence) : null,
        draft.location ? JSON.stringify(draft.location) : null,
        Date.now(),
        now,
        now
      );
    return this.get(id)!;
  },

  update(id: string, patch: TaskPatch): Task | null {
    const existing = this.get(id);
    if (!existing) return null;
    const db = getDb();
    const now = nowIso();
    // Which list the task ends up on: a subtask follows its parent, anything
    // else takes the patch's space when it names one.
    const parentId = "parentId" in patch ? patch.parentId || null : existing.parentId;
    const asked = patch.space === "joint" || patch.space === "personal" ? patch.space : existing.space;
    const space = (parentId ? spaceOf(parentId) : null) ?? asked;
    const moved = space !== existing.space;
    const effective: TaskPatch = { ...patch };
    // Personal projects don't hold shared tasks, and only the shared list has
    // someone else to hand a task to.
    if (moved && space === "joint") effective.projectId = null;
    if (moved && space === "personal") effective.assignedTo = null;

    const sets: string[] = ["updated_at=?"];
    const params: unknown[] = [now];
    const map: [keyof TaskPatch, string, (v: unknown) => unknown][] = [
      ["title", "title", (v) => String(v).trim()],
      ["assignedTo", "assigned_to", (v) => (v === "owner" || v === "partner" ? v : null)],
      ["notes", "notes", (v) => v],
      ["priority", "priority", (v) => v],
      ["dueAt", "due_at", (v) => v],
      ["dueKind", "due_kind", (v) => (v === "by" ? "by" : "on")],
      ["allDay", "all_day", (v) => (v ? 1 : 0)],
      ["projectId", "project_id", (v) => v],
      ["tags", "tags", (v) => JSON.stringify(v ?? [])],
      // An empty id would hide the task from every list (they want IS NULL).
      ["parentId", "parent_id", (v) => v || null],
      ["recurrence", "recurrence", (v) => (v ? JSON.stringify(v) : null)],
      ["location", "location", (v) => (v ? JSON.stringify(v) : null)],
      ["sort", "sort", (v) => v],
    ];
    for (const [key, col, conv] of map) {
      if (key in effective) {
        sets.push(`${col}=?`);
        params.push(conv(effective[key]));
      }
    }
    if (moved) {
      sets.push("space=?");
      params.push(space);
    }
    // Only a new due moment earns a new reminder; resending the same one
    // with an unrelated edit must not fire it again.
    if ("dueAt" in effective && !sameMoment(effective.dueAt, existing.dueAt)) {
      sets.push("notified_at=NULL");
    }
    params.push(id);
    db.transaction(() => {
      db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id=?`).run(...params);
      if (moved) {
        // Its subtasks move with it.
        db.prepare(
          `UPDATE tasks SET space=?, assigned_to=CASE WHEN ?='personal' THEN NULL ELSE assigned_to END,
           updated_at=? WHERE parent_id=?`
        ).run(space, space, now, id);
      }
    })();
    return this.get(id);
  },

  remove(id: string): void {
    const db = getDb();
    db.prepare("DELETE FROM tasks WHERE parent_id=?").run(id);
    db.prepare("DELETE FROM tasks WHERE id=?").run(id);
  },

  /**
   * Complete / un-complete. For recurring top-level tasks, completion logs the
   * occurrence and moves due_at to the first occurrence after now (the task
   * stays open). Asking for the state a task is already in changes nothing,
   * so a second tick from another device or a replayed request can't log
   * twice, skip an occurrence or delete real history; `changed` says whether
   * anything happened. `expectedDueAt` is the due the caller was looking at:
   * a repeat that has moved on since then is left alone. `by` is who ticked it.
   */
  setDone(
    id: string,
    done: boolean,
    opts: { by?: SessionRole; expectedDueAt?: string | null } = {}
  ): { task: Task | null; recurred: boolean; changed: boolean } {
    const task = this.get(id);
    if (!task) return { task: null, recurred: false, changed: false };
    const tz = settingsRepo.getApp().tz;
    const now = nowIso();
    const db = getDb();
    const unchanged = { task, recurred: false, changed: false };

    if (done) {
      if (task.status === "done") return unchanged;
      if (task.recurrence && !task.parentId) {
        if (opts.expectedDueAt !== undefined && !sameMoment(opts.expectedDueAt, task.dueAt)) {
          return unchanged;
        }
        const next = nextDueAfterDone(task.recurrence, task.dueAt, task.allDay, new Date(now), tz);
        const rule = JSON.stringify(next.rule);
        db.transaction(() => {
          completionsRepo.log(task.id, task.title, now, localDateKey(now, tz), opts.by);
          db.prepare(
            "UPDATE tasks SET due_at=?, all_day=?, notified_at=NULL, updated_at=? WHERE id=?"
          ).run(next.dueAt, next.allDay ? 1 : 0, now, id);
          // Keep the pinned anchor day, so the next tick reads the true day
          // back rather than a short month's clamped one.
          if (rule !== JSON.stringify(task.recurrence)) {
            db.prepare("UPDATE tasks SET recurrence=? WHERE id=?").run(rule, id);
          }
        })();
        return { task: this.get(id), recurred: true, changed: true };
      }
      db.transaction(() => {
        completionsRepo.log(task.id, task.title, now, localDateKey(now, tz), opts.by);
        db.prepare("UPDATE tasks SET status='done', completed_at=?, updated_at=? WHERE id=?").run(
          now,
          now,
          id
        );
      })();
      return { task: this.get(id), recurred: false, changed: true };
    }

    // Only a done task has a tick to take back. A repeat stays open, so its
    // Logbook entries come out one at a time through unlog() instead.
    if (task.status !== "done") return unchanged;
    db.transaction(() => {
      completionsRepo.removeLatestForTask(id);
      db.prepare("UPDATE tasks SET status='open', completed_at=NULL, updated_at=? WHERE id=?").run(
        now,
        id
      );
    })();
    return { task: this.get(id), recurred: false, changed: true };
  },

  /**
   * Take one entry back out of the Logbook. A task that this entry left done
   * goes back on the open list; a repeat keeps its next date. Null when the
   * entry is already gone; `task` is null when the task itself no longer
   * exists, and then nothing is removed.
   */
  unlog(completionId: string): { task: Task | null; removed: boolean; reopened: boolean } | null {
    const entry = completionsRepo.get(completionId);
    if (!entry) return null;
    const task = this.get(entry.taskId);
    if (!task) return { task: null, removed: false, reopened: false };
    const db = getDb();
    let reopened = false;
    db.transaction(() => {
      completionsRepo.remove(entry.id);
      const later = db
        .prepare("SELECT 1 FROM completions WHERE task_id=? AND completed_at>=? LIMIT 1")
        .get(task.id, entry.completedAt);
      if (task.status === "done" && !later) {
        db.prepare("UPDATE tasks SET status='open', completed_at=NULL, updated_at=? WHERE id=?").run(
          nowIso(),
          task.id
        );
        reopened = true;
      }
    })();
    return { task: this.get(task.id), removed: true, reopened };
  },

  reorder(ids: string[]): void {
    const db = getDb();
    const stmt = db.prepare("UPDATE tasks SET sort=? WHERE id=?");
    const tx = db.transaction((list: string[]) => {
      list.forEach((id, i) => stmt.run(i, id));
    });
    tx(ids);
  },

  /** Open, timed tasks whose due moment has passed and were never notified */
  dueForReminder(nowIsoStr: string): Task[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM tasks WHERE status='open' AND all_day=0 AND due_at IS NOT NULL
         AND due_at <= ? AND notified_at IS NULL ORDER BY due_at ASC LIMIT 20`
      )
      .all(nowIsoStr) as TaskRow[];
    return rows.map(rowToTask);
  },

  markNotified(id: string): void {
    getDb().prepare("UPDATE tasks SET notified_at=? WHERE id=?").run(nowIso(), id);
  },

  /** Which deadline each open joint task was last nudged about, by task id. */
  nudgeState(): Map<string, string> {
    const rows = getDb()
      .prepare(
        `SELECT id, nudged_due_at FROM tasks
         WHERE status='open' AND space='joint' AND nudged_due_at IS NOT NULL`
      )
      .all() as { id: string; nudged_due_at: string }[];
    return new Map(rows.map((r) => [r.id, r.nudged_due_at]));
  },

  /** Remember that this deadline has already been raised once. */
  markNudged(id: string, dueAt: string): void {
    getDb().prepare("UPDATE tasks SET nudged_due_at=? WHERE id=?").run(dueAt, id);
  },

  /** Open, top-level tasks that carry a location. */
  /** Open, top-level, project-less tasks that carry a location. */
  located(): Task[] {
    const rows = getDb()
      .prepare(
        `SELECT * FROM tasks WHERE status='open' AND parent_id IS NULL
         AND space='personal' AND project_id IS NULL AND location IS NOT NULL LIMIT 200`
      )
      .all() as TaskRow[];
    return rows.map(rowToTask);
  },

  allTags(): string[] {
    const rows = getDb()
      .prepare("SELECT tags FROM tasks WHERE status='open' AND space='personal'")
      .all() as { tags: string }[];
    const set = new Set<string>();
    for (const r of rows) {
      for (const t of JSON.parse(r.tags || "[]") as string[]) set.add(t);
    }
    return [...set].sort();
  },

  counts(): { open: number; overdue: number } {
    const settings = settingsRepo.getApp();
    const todayKey = localDateKey(new Date(), settings.tz);
    const startToday = isoStartOfLocalDay(todayKey, settings.tz);
    const open = (
      getDb()
        .prepare("SELECT COUNT(*) c FROM tasks WHERE status='open' AND parent_id IS NULL AND space='personal'")
        .get() as { c: number }
    ).c;
    const overdue = (
      getDb()
        .prepare(
          "SELECT COUNT(*) c FROM tasks WHERE status='open' AND parent_id IS NULL AND space='personal' AND due_at IS NOT NULL AND due_at < ?"
        )
        .get(startToday) as { c: number }
    ).c;
    return { open, overdue };
  },
};

function isoStartOfLocalDay(dateKey: string, tz: string): string {
  return isoFromLocal(dateKey, "00:00", tz);
}

/** Which list a task is on, or null when there is no such task. */
function spaceOf(id: string): "personal" | "joint" | null {
  const row = getDb().prepare("SELECT space FROM tasks WHERE id=?").get(id) as
    | { space: string }
    | undefined;
  if (!row) return null;
  return row.space === "joint" ? "joint" : "personal";
}

// ── Completions / stats ────────────────────────────────────────────────────

/** Every AI call's token cost, so the Usage screen can add it up. */
export const usageRepo = {
  add(entry: {
    provider: string;
    model: string;
    feature: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    dateLocal: string;
  }): void {
    getDb()
      .prepare(
        "INSERT INTO ai_usage(id,at,date_local,provider,model,feature,input_tokens,output_tokens,cached_input_tokens,cache_write_tokens) VALUES(?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        newId(),
        nowIso(),
        entry.dateLocal,
        entry.provider,
        entry.model.slice(0, 120),
        entry.feature.slice(0, 40),
        Math.max(0, Math.round(entry.inputTokens)),
        Math.max(0, Math.round(entry.outputTokens)),
        Math.max(0, Math.round(entry.cachedInputTokens ?? 0)),
        Math.max(0, Math.round(entry.cacheWriteTokens ?? 0))
      );
  },

  /** Rows on or after a local date key, oldest first. */
  since(fromKey: string): UsageRow[] {
    const rows = getDb()
      .prepare(
        "SELECT date_local, provider, model, feature, input_tokens, output_tokens, cached_input_tokens FROM ai_usage WHERE date_local >= ? ORDER BY date_local ASC"
      )
      .all(fromKey) as {
      date_local: string;
      provider: string;
      model: string;
      feature: string;
      input_tokens: number;
      output_tokens: number;
      cached_input_tokens: number;
    }[];
    return rows.map((r) => ({
      dateLocal: r.date_local,
      provider: r.provider,
      model: r.model,
      feature: r.feature,
      inputTokens: r.input_tokens,
      cachedInputTokens: r.cached_input_tokens ?? 0,
      outputTokens: r.output_tokens,
    }));
  },

  /** Lifetime figures, without pulling every row into memory. */
  lifetime(): { calls: number; input: number; output: number; total: number; firstDay: string | null } {
    const row = getDb()
      .prepare(
        "SELECT COUNT(*) calls, COALESCE(SUM(input_tokens),0) input, COALESCE(SUM(output_tokens),0) output, MIN(date_local) first_day FROM ai_usage"
      )
      .get() as { calls: number; input: number; output: number; first_day: string | null };
    return {
      calls: row.calls,
      input: row.input,
      output: row.output,
      total: row.input + row.output,
      firstDay: row.first_day,
    };
  },

  /** Keep roughly a year and a month, so "last month" is always whole. */
  prune(beforeKey: string): number {
    return getDb().prepare("DELETE FROM ai_usage WHERE date_local < ?").run(beforeKey).changes;
  },

  clear(): void {
    getDb().prepare("DELETE FROM ai_usage").run();
  },
};

// The owner-facing figures below (stats, streak, Logbook, weekly review) count
// only the owner's own ticks, never the partner's on the shared list.
export const completionsRepo = {
  log(
    taskId: string,
    title: string,
    completedAt: string,
    dateLocal: string,
    completedBy: SessionRole = "owner"
  ): void {
    getDb()
      .prepare(
        "INSERT INTO completions(id, task_id, title, completed_at, date_local, completed_by) VALUES(?,?,?,?,?,?)"
      )
      .run(newId(), taskId, title, completedAt, dateLocal, completedBy === "partner" ? "partner" : "owner");
  },
  get(id: string): { id: string; taskId: string; completedAt: string } | null {
    const row = getDb()
      .prepare("SELECT id, task_id, completed_at FROM completions WHERE id=?")
      .get(id) as { id: string; task_id: string; completed_at: string } | undefined;
    return row ? { id: row.id, taskId: row.task_id, completedAt: row.completed_at } : null;
  },
  remove(id: string): void {
    getDb().prepare("DELETE FROM completions WHERE id=?").run(id);
  },
  removeLatestForTask(taskId: string): void {
    getDb()
      .prepare(
        "DELETE FROM completions WHERE id = (SELECT id FROM completions WHERE task_id=? ORDER BY completed_at DESC LIMIT 1)"
      )
      .run(taskId);
  },
  countsByDay(fromKey: string, toKey: string): Map<string, number> {
    const rows = getDb()
      .prepare(
        "SELECT date_local, COUNT(*) c FROM completions WHERE date_local >= ? AND date_local <= ? AND completed_by='owner' GROUP BY date_local"
      )
      .all(fromKey, toKey) as { date_local: string; c: number }[];
    return new Map(rows.map((r) => [r.date_local, r.c]));
  },
  countRange(fromKey: string, toKey: string): number {
    const row = getDb()
      .prepare(
        "SELECT COUNT(*) c FROM completions WHERE date_local >= ? AND date_local <= ? AND completed_by='owner'"
      )
      .get(fromKey, toKey) as { c: number };
    return row.c;
  },
  /** The owner's own ticks, on either list, grouped newest-day-first for the
   *  Logbook (project work stays on its own tab). */
  logbook(fromKey: string, toKey: string): { dateLocal: string; entries: { id: string; taskId: string; title: string; completedAt: string }[] }[] {
    const rows = getDb()
      .prepare(
        `SELECT c.id, c.task_id, c.title, c.completed_at, c.date_local
         FROM completions c LEFT JOIN tasks t ON t.id = c.task_id
         WHERE c.date_local >= ? AND c.date_local <= ? AND c.completed_by='owner'
           AND t.project_id IS NULL
         ORDER BY c.completed_at DESC LIMIT 500`
      )
      .all(fromKey, toKey) as { id: string; task_id: string; title: string; completed_at: string; date_local: string }[];
    const byDay = new Map<string, { id: string; taskId: string; title: string; completedAt: string }[]>();
    for (const r of rows) {
      const list = byDay.get(r.date_local) ?? [];
      list.push({ id: r.id, taskId: r.task_id, title: r.title, completedAt: r.completed_at });
      byDay.set(r.date_local, list);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([dateLocal, entries]) => ({ dateLocal, entries }));
  },

  listRange(fromKey: string, toKey: string): { title: string; dateLocal: string }[] {
    const rows = getDb()
      .prepare(
        "SELECT title, date_local FROM completions WHERE date_local >= ? AND date_local <= ? AND completed_by='owner' ORDER BY completed_at ASC"
      )
      .all(fromKey, toKey) as { title: string; date_local: string }[];
    return rows.map((r) => ({ title: r.title, dateLocal: r.date_local }));
  },
};

export const statsRepo = {
  summary(): StatsSummary {
    const settings = settingsRepo.getApp();
    const tz = settings.tz;
    const todayKey = localDateKey(new Date(), tz);
    const from = addDaysToDateKey(todayKey, -370);
    const byDay = completionsRepo.countsByDay(from, todayKey);

    let streak = 0;
    let cursor = todayKey;
    if (!byDay.get(cursor)) cursor = addDaysToDateKey(cursor, -1); // today not yet broken
    while (byDay.get(cursor)) {
      streak++;
      cursor = addDaysToDateKey(cursor, -1);
    }

    const week: { dateLocal: string; done: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const k = addDaysToDateKey(todayKey, -i);
      week.push({ dateLocal: k, done: byDay.get(k) ?? 0 });
    }

    const counts = tasksRepo.counts();
    const doneToday = byDay.get(todayKey) ?? 0;
    const openToday = tasksRepo.list({ view: "today" }).length;
    return {
      today: { done: doneToday, open: openToday },
      streakDays: streak,
      week,
      totalOpen: counts.open,
      overdue: counts.overdue,
    };
  },
};

// ── Projects ───────────────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  name: string;
  color: string;
  icon: string;
  sort: number;
  archived: number;
  created_at: string;
}

/** A name as matched by findByName / findByTitle: trimmed, NFC, any-script lower case. */
function nameKey(value: string): string {
  return value.trim().normalize("NFC").toLocaleLowerCase();
}

export const projectsRepo = {
  list(includeArchived = false): Project[] {
    const rows = getDb()
      .prepare(
        `SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.status='open' AND t.parent_id IS NULL) open_count
         FROM projects p ${includeArchived ? "" : "WHERE p.archived=0"} ORDER BY p.sort ASC, p.created_at ASC`
      )
      .all() as (ProjectRow & { open_count: number })[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      icon: r.icon,
      sort: r.sort,
      archived: !!r.archived,
      createdAt: r.created_at,
      openCount: r.open_count,
    }));
  },
  get(id: string): Project | null {
    const r = getDb().prepare("SELECT * FROM projects WHERE id=?").get(id) as
      | ProjectRow
      | undefined;
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      color: r.color,
      icon: r.icon,
      sort: r.sort,
      archived: !!r.archived,
      createdAt: r.created_at,
    };
  },
  /**
   * A project by name, a live one first. An archived match is restored, since
   * filing something into it means it is wanted again (and creating another
   * would leave two of the same name); pass `{ restore: false }` for a lookup
   * that must not change anything, which returns it still archived.
   */
  findByName(name: string, opts: { restore?: boolean } = {}): Project | null {
    // Compared here, not with SQLite's lower(), which folds only A-Z ("École").
    const want = nameKey(name);
    const rows = getDb()
      .prepare("SELECT id, name, archived FROM projects ORDER BY archived ASC, sort ASC, created_at ASC")
      .all() as Pick<ProjectRow, "id" | "name" | "archived">[];
    const r = rows.find((row) => nameKey(row.name) === want);
    if (!r) return null;
    if (r.archived && opts.restore !== false) return this.update(r.id, { archived: false });
    return this.get(r.id);
  },
  create(input: { name: string; color?: string; icon?: string }): Project {
    const id = newId();
    getDb()
      .prepare("INSERT INTO projects(id,name,color,icon,sort,created_at) VALUES(?,?,?,?,?,?)")
      .run(id, input.name.trim(), input.color ?? "#FFA94D", input.icon ?? "📁", Date.now(), nowIso());
    return this.get(id)!;
  },
  update(id: string, patch: Partial<Pick<Project, "name" | "color" | "icon" | "sort" | "archived">>): Project | null {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.name !== undefined) (sets.push("name=?"), params.push(patch.name.trim()));
    if (patch.color !== undefined) (sets.push("color=?"), params.push(patch.color));
    if (patch.icon !== undefined) (sets.push("icon=?"), params.push(patch.icon));
    if (patch.sort !== undefined) (sets.push("sort=?"), params.push(patch.sort));
    if (patch.archived !== undefined) (sets.push("archived=?"), params.push(patch.archived ? 1 : 0));
    if (sets.length) {
      params.push(id);
      getDb().prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id=?`).run(...params);
    }
    return this.get(id);
  },
  remove(id: string): void {
    const db = getDb();
    db.prepare("UPDATE tasks SET project_id=NULL WHERE project_id=?").run(id);
    db.prepare("DELETE FROM projects WHERE id=?").run(id);
  },
};

// ── Notes ──────────────────────────────────────────────────────────────────

interface NoteRow {
  id: string;
  title: string;
  kind: string;
  content: string;
  items: string;
  color: string | null;
  pinned: number;
  archived: number;
  created_at: string;
  updated_at: string;
}

function rowToNote(r: NoteRow): Note {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind as Note["kind"],
    content: r.content,
    items: JSON.parse(r.items || "[]"),
    color: r.color,
    pinned: !!r.pinned,
    archived: !!r.archived,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const notesRepo = {
  list(opts: { q?: string; archived?: boolean } = {}): Note[] {
    const where: string[] = [`archived=${opts.archived ? 1 : 0}`];
    const params: unknown[] = [];
    if (opts.q) {
      // Checklist items are matched on their text only, never the JSON
      // around it ("done", "text", ids), and the query is taken literally.
      where.push(
        `(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR EXISTS (
           SELECT 1 FROM json_tree(CASE WHEN json_valid(items) THEN items ELSE '[]' END) j
           WHERE j.key = 'text' AND j.type = 'text' AND j.value LIKE ? ESCAPE '\\'))`
      );
      const pattern = likeContains(opts.q);
      params.push(pattern, pattern, pattern);
    }
    const rows = getDb()
      .prepare(
        `SELECT * FROM notes WHERE ${where.join(" AND ")} ORDER BY pinned DESC, updated_at DESC LIMIT 200`
      )
      .all(...params) as NoteRow[];
    return rows.map(rowToNote);
  },
  get(id: string): Note | null {
    const r = getDb().prepare("SELECT * FROM notes WHERE id=?").get(id) as NoteRow | undefined;
    return r ? rowToNote(r) : null;
  },
  findByTitle(title: string): Note | null {
    // Compared here, not with SQLite's lower(), which folds only A-Z.
    const want = nameKey(title);
    const rows = getDb()
      .prepare("SELECT id, title FROM notes WHERE archived=0 ORDER BY rowid ASC")
      .all() as Pick<NoteRow, "id" | "title">[];
    const r = rows.find((row) => nameKey(row.title) === want);
    return r ? this.get(r.id) : null;
  },
  create(input: Partial<Note> & { kind?: Note["kind"] }): Note {
    const id = newId();
    const now = nowIso();
    getDb()
      .prepare(
        "INSERT INTO notes(id,title,kind,content,items,color,pinned,archived,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)"
      )
      .run(
        id,
        input.title ?? "",
        input.kind ?? "note",
        input.content ?? "",
        JSON.stringify(input.items ?? []),
        input.color ?? null,
        input.pinned ? 1 : 0,
        0,
        now,
        now
      );
    return this.get(id)!;
  },
  update(id: string, patch: Partial<Note>): Note | null {
    const sets: string[] = ["updated_at=?"];
    const params: unknown[] = [nowIso()];
    if (patch.title !== undefined) (sets.push("title=?"), params.push(patch.title));
    if (patch.kind !== undefined) (sets.push("kind=?"), params.push(patch.kind));
    if (patch.content !== undefined) (sets.push("content=?"), params.push(patch.content));
    if (patch.items !== undefined) (sets.push("items=?"), params.push(JSON.stringify(patch.items)));
    if (patch.color !== undefined) (sets.push("color=?"), params.push(patch.color));
    if (patch.pinned !== undefined) (sets.push("pinned=?"), params.push(patch.pinned ? 1 : 0));
    if (patch.archived !== undefined) (sets.push("archived=?"), params.push(patch.archived ? 1 : 0));
    params.push(id);
    getDb().prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id=?`).run(...params);
    return this.get(id);
  },
  remove(id: string): void {
    getDb().prepare("DELETE FROM notes WHERE id=?").run(id);
  },
};

// ── Inbox ──────────────────────────────────────────────────────────────────

interface InboxRow {
  id: string;
  source: string;
  external_id: string | null;
  from_label: string;
  content: string;
  received_at: string;
  status: string;
  suggestion: string | null;
  resolved_task_id: string | null;
  created_at: string;
}

function rowToInbox(r: InboxRow): InboxItem {
  return {
    id: r.id,
    source: r.source as InboxSource,
    externalId: r.external_id,
    fromLabel: r.from_label,
    content: r.content,
    receivedAt: r.received_at,
    status: r.status as InboxStatus,
    suggestion: r.suggestion ? JSON.parse(r.suggestion) : null,
    resolvedTaskId: r.resolved_task_id,
    createdAt: r.created_at,
  };
}

export const inboxRepo = {
  list(opts: { status?: InboxStatus | "all" } = {}): InboxItem[] {
    const status = opts.status ?? "new";
    const rows = (
      status === "all"
        ? // Every unresolved item, plus the latest 100 of history: a burst of
          // auto-dismissed mail must never push something still waiting out.
          getDb()
            .prepare(
              `SELECT * FROM inbox_items WHERE status='new'
               UNION ALL
               SELECT * FROM (SELECT * FROM inbox_items WHERE status<>'new' ORDER BY received_at DESC LIMIT 100)
               ORDER BY received_at DESC`
            )
            .all()
        : getDb()
            .prepare("SELECT * FROM inbox_items WHERE status=? ORDER BY received_at DESC LIMIT 100")
            .all(status)
    ) as InboxRow[];
    return rows.map(rowToInbox);
  },
  get(id: string): InboxItem | null {
    const r = getDb().prepare("SELECT * FROM inbox_items WHERE id=?").get(id) as
      | InboxRow
      | undefined;
    return r ? rowToInbox(r) : null;
  },
  /** Insert; returns null when externalId already exists (dedupe) */
  create(input: {
    source: InboxSource;
    externalId?: string | null;
    fromLabel?: string;
    content: string;
    receivedAt?: string;
  }): InboxItem | null {
    const id = newId();
    const res = getDb()
      .prepare(
        `INSERT OR IGNORE INTO inbox_items(id,source,external_id,from_label,content,received_at,status,created_at)
         VALUES(?,?,?,?,?,?,'new',?)`
      )
      .run(
        id,
        input.source,
        input.externalId ?? null,
        input.fromLabel ?? "",
        input.content,
        input.receivedAt ?? nowIso(),
        nowIso()
      );
    if (res.changes === 0) return null;
    return this.get(id);
  },
  setSuggestion(id: string, suggestion: InboxSuggestion): void {
    getDb()
      .prepare("UPDATE inbox_items SET suggestion=? WHERE id=?")
      .run(JSON.stringify(suggestion), id);
  },
  /** Bring a resolved/dismissed item back to the inbox for fresh triage. */
  restore(id: string): void {
    getDb()
      .prepare(
        "UPDATE inbox_items SET status='new', suggestion=NULL, resolved_task_id=NULL WHERE id=?"
      )
      .run(id);
  },
  resolve(id: string, status: "resolved" | "dismissed", resolvedTaskId?: string | null): void {
    getDb()
      .prepare("UPDATE inbox_items SET status=?, resolved_task_id=? WHERE id=?")
      .run(status, resolvedTaskId ?? null, id);
  },
  newCount(): number {
    const row = getDb()
      .prepare("SELECT COUNT(*) c FROM inbox_items WHERE status='new'")
      .get() as { c: number };
    return row.c;
  },
};

// ── Triage feedback (self-tuning lessons) ──────────────────────────────────

interface FeedbackRow {
  id: string;
  kind: string;
  reason: string;
  content: string;
  from_label: string;
  source: string;
  created_at: string;
}

function rowToFeedback(r: FeedbackRow): TriageFeedback {
  return {
    id: r.id,
    kind: r.kind as TriageFeedback["kind"],
    reason: r.reason,
    content: r.content,
    fromLabel: r.from_label,
    source: r.source as InboxSource,
    createdAt: r.created_at,
  };
}

export const feedbackRepo = {
  add(input: {
    kind: TriageFeedback["kind"];
    reason: string;
    content: string;
    fromLabel: string;
    source: InboxSource;
  }): TriageFeedback {
    const id = newId();
    const db = getDb();
    db.prepare(
      "INSERT INTO triage_feedback(id,kind,reason,content,from_label,source,created_at) VALUES(?,?,?,?,?,?,?)"
    ).run(
      id,
      input.kind,
      input.reason.trim().slice(0, 240),
      input.content.slice(0, 200),
      input.fromLabel.slice(0, 120),
      input.source,
      nowIso()
    );
    // Bounded memory: the prompt only ever reads the newest lessons anyway.
    db.prepare(
      "DELETE FROM triage_feedback WHERE id NOT IN (SELECT id FROM triage_feedback ORDER BY created_at DESC LIMIT 100)"
    ).run();
    return rowToFeedback(
      db.prepare("SELECT * FROM triage_feedback WHERE id=?").get(id) as FeedbackRow
    );
  },
  list(limit = 50): TriageFeedback[] {
    const rows = getDb()
      .prepare("SELECT * FROM triage_feedback ORDER BY created_at DESC LIMIT ?")
      .all(limit) as FeedbackRow[];
    return rows.map(rowToFeedback);
  },
  remove(id: string): void {
    getDb().prepare("DELETE FROM triage_feedback WHERE id=?").run(id);
  },
};

// ── Plans / briefings / reviews ────────────────────────────────────────────

export const briefingsRepo = {
  get(dateLocal: string): Briefing | null {
    const r = getDb().prepare("SELECT content FROM briefings WHERE date_local=?").get(dateLocal) as
      | { content: string }
      | undefined;
    return r ? (JSON.parse(r.content) as Briefing) : null;
  },
  save(b: Briefing): void {
    getDb()
      .prepare(
        `INSERT INTO briefings(date_local,content,generated_at) VALUES(?,?,?)
         ON CONFLICT(date_local) DO UPDATE SET content=excluded.content, generated_at=excluded.generated_at`
      )
      .run(b.dateLocal, JSON.stringify(b), b.generatedAt);
  },
};

export const reviewsRepo = {
  get(weekKey: string): WeeklyReview | null {
    const r = getDb().prepare("SELECT content FROM reviews WHERE week_key=?").get(weekKey) as
      | { content: string }
      | undefined;
    return r ? (JSON.parse(r.content) as WeeklyReview) : null;
  },
  save(rv: WeeklyReview): void {
    getDb()
      .prepare(
        `INSERT INTO reviews(week_key,content,generated_at) VALUES(?,?,?)
         ON CONFLICT(week_key) DO UPDATE SET content=excluded.content, generated_at=excluded.generated_at`
      )
      .run(rv.weekKey, JSON.stringify(rv), rv.generatedAt);
  },
};

// ── Conversations / messages ───────────────────────────────────────────────

export const conversationsRepo = {
  create(title = "New chat"): Conversation {
    const id = newId();
    const now = nowIso();
    getDb()
      .prepare("INSERT INTO conversations(id,title,created_at,updated_at) VALUES(?,?,?,?)")
      .run(id, title, now, now);
    return { id, title, createdAt: now, updatedAt: now };
  },
  get(id: string): Conversation | null {
    const r = getDb().prepare("SELECT * FROM conversations WHERE id=?").get(id) as
      | { id: string; title: string; created_at: string; updated_at: string }
      | undefined;
    return r ? { id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at } : null;
  },
  listRecent(limit = 20): Conversation[] {
    const rows = getDb()
      .prepare("SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as { id: string; title: string; created_at: string; updated_at: string }[];
    return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.created_at, updatedAt: r.updated_at }));
  },
  rename(id: string, title: string): void {
    getDb().prepare("UPDATE conversations SET title=? WHERE id=?").run(title.slice(0, 80), id);
  },
  addMessage(
    conversationId: string,
    role: ChatRole,
    text: string,
    activity: ToolActivity[] = []
  ): ChatMessageRecord {
    const id = newId();
    const now = nowIso();
    const db = getDb();
    db.prepare(
      "INSERT INTO messages(id,conversation_id,role,text,activity,created_at) VALUES(?,?,?,?,?,?)"
    ).run(id, conversationId, role, text, JSON.stringify(activity), now);
    db.prepare("UPDATE conversations SET updated_at=? WHERE id=?").run(now, conversationId);
    return { id, conversationId, role, text, activity, createdAt: now };
  },
  messages(conversationId: string, limit = 60): ChatMessageRecord[] {
    const rows = getDb()
      .prepare(
        // Insertion order breaks same-millisecond ties (a message and an
        // instant reply), so they never come back reversed.
        "SELECT * FROM (SELECT *, rowid AS seq FROM messages WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at ASC, seq ASC"
      )
      .all(conversationId, limit) as {
      id: string;
      conversation_id: string;
      role: string;
      text: string;
      activity: string;
      created_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      role: r.role as ChatRole,
      text: r.text,
      activity: JSON.parse(r.activity || "[]"),
      createdAt: r.created_at,
    }));
  },
};

// ── Push subscriptions ─────────────────────────────────────────────────────

export const pushRepo = {
  /**
   * Upserts a device's subscription under the role (and, when given, the
   * session) that posted it. The session link is stored inside the JSON, as
   * a hash, so ending a session can drop the devices it registered
   * (pruneSignedOut) without a schema change.
   */
  add(
    subscription: { endpoint: string } & Record<string, unknown>,
    role: "owner" | "partner" = "owner",
    sessionToken?: string
  ): void {
    const stored = sessionToken
      ? { ...subscription, _session: pushRepo.sessionRef(sessionToken) }
      : subscription;
    getDb()
      .prepare(
        `INSERT INTO push_subscriptions(endpoint,subscription,created_at,role) VALUES(?,?,?,?)
         ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription, role=excluded.role`
      )
      .run(subscription.endpoint, JSON.stringify(stored), nowIso(), role);
  },
  /** One-way reference to a session token, so this table never holds a usable one. */
  sessionRef(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex").slice(0, 32);
  },
  list(roles?: ("owner" | "partner")[]): {
    endpoint: string;
    subscription: Record<string, unknown>;
  }[] {
    const all = getDb().prepare("SELECT * FROM push_subscriptions").all() as {
      endpoint: string;
      subscription: string;
      role: string;
    }[];
    const wanted = roles ?? ["owner", "partner"];
    return all
      .filter((r) => wanted.includes(r.role === "partner" ? "partner" : "owner"))
      .map((r) => {
        const subscription = JSON.parse(r.subscription) as Record<string, unknown>;
        delete subscription._session;
        return { endpoint: r.endpoint, subscription };
      });
  },
  /** Drops every subscription of one role. */
  removeRole(role: "owner" | "partner"): void {
    getDb().prepare("DELETE FROM push_subscriptions WHERE role=?").run(role);
  },
  /**
   * Drops subscriptions whose session has ended (signed out, revoked or
   * expired). Rows saved before subscriptions were linked to a session carry
   * no link and are kept; the app re-posts them, linked, on its next load.
   */
  pruneSignedOut(): void {
    const live = new Set(sessionsRepo.liveTokens().map((t) => pushRepo.sessionRef(t)));
    const rows = getDb().prepare("SELECT endpoint, subscription FROM push_subscriptions").all() as {
      endpoint: string;
      subscription: string;
    }[];
    const drop = getDb().prepare("DELETE FROM push_subscriptions WHERE endpoint=?");
    for (const r of rows) {
      let ref: unknown;
      try {
        ref = (JSON.parse(r.subscription) as { _session?: unknown })._session;
      } catch {
        continue;
      }
      if (typeof ref === "string" && !live.has(ref)) drop.run(r.endpoint);
    }
  },
  remove(endpoint: string): void {
    getDb().prepare("DELETE FROM push_subscriptions WHERE endpoint=?").run(endpoint);
  },
};

// ── Google tokens ──────────────────────────────────────────────────────────

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  expiry: string; // ISO
  email: string;
  scopes: string[];
}

export const googleRepo = {
  get(): GoogleTokens | null {
    const r = getDb().prepare("SELECT * FROM google_tokens WHERE id='default'").get() as
      | { access_token: string; refresh_token: string; expiry: string; email: string; scopes: string }
      | undefined;
    if (!r || !r.refresh_token) return null;
    return {
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      expiry: r.expiry,
      email: r.email,
      scopes: r.scopes ? r.scopes.split(" ") : [],
    };
  },
  save(t: GoogleTokens): void {
    getDb()
      .prepare(
        `INSERT INTO google_tokens(id,access_token,refresh_token,expiry,email,scopes)
         VALUES('default',?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET access_token=excluded.access_token,
           refresh_token=excluded.refresh_token, expiry=excluded.expiry,
           email=excluded.email, scopes=excluded.scopes`
      )
      .run(t.accessToken, t.refreshToken, t.expiry, t.email, t.scopes.join(" "));
  },
  clear(): void {
    getDb().prepare("DELETE FROM google_tokens WHERE id='default'").run();
  },
};

// ── Export / import ────────────────────────────────────────────────────────

export function exportAll(): Record<string, unknown> {
  const db = getDb();
  return {
    app: "DoneX",
    version: 1,
    exportedAt: nowIso(),
    tasks: db.prepare("SELECT * FROM tasks").all(),
    projects: db.prepare("SELECT * FROM projects").all(),
    notes: db.prepare("SELECT * FROM notes").all(),
    completions: db.prepare("SELECT * FROM completions").all(),
    inbox: db.prepare("SELECT * FROM inbox_items").all(),
  };
}

/** A file that can't be imported; the message says why, for the person importing it. */
export class ImportError extends Error {}

/** The real columns of a table, so names from a file never reach SQL unchecked. */
export function tableColumns(table: string): Set<string> {
  return new Set(
    (getDb().pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name)
  );
}

/** What exportAll writes, by file key and table, and the columns holding JSON. */
const isRecord = (v: unknown): boolean => v !== null && typeof v === "object" && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): boolean =>
  Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isRule = (v: unknown): boolean => {
  if (!isRecord(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    ["daily", "weekly", "monthly", "yearly"].includes(r.freq as string) &&
    (r.interval === undefined || isInt(r.interval, 1, 1000)) &&
    (r.byWeekday === undefined ||
      (Array.isArray(r.byWeekday) && r.byWeekday.every((d) => isInt(d, 0, 6)))) &&
    (r.byMonthDay === undefined || isInt(r.byMonthDay, 1, 31))
  );
};

/**
 * What exportAll writes, by file key and table. `json` columns must hold the
 * shape the app reads back, and `oneOf` columns one of the values it knows;
 * anything else would break or hide rows after the import.
 */
const IMPORT_TABLES: {
  key: string;
  table: string;
  json: Record<string, (v: unknown) => boolean>;
  oneOf: Record<string, string[]>;
}[] = [
  { key: "projects", table: "projects", json: {}, oneOf: {} },
  {
    key: "tasks",
    table: "tasks",
    json: {
      tags: (v) => Array.isArray(v) && v.every((t) => typeof t === "string"),
      recurrence: (v) => v === null || isRule(v),
      location: (v) => v === null || isRecord(v),
    },
    oneOf: { status: ["open", "done"], space: ["personal", "joint"] },
  },
  { key: "notes", table: "notes", json: { items: (v) => Array.isArray(v) }, oneOf: {} },
  { key: "completions", table: "completions", json: {}, oneOf: { completed_by: ["owner", "partner"] } },
  {
    key: "inbox",
    table: "inbox_items",
    json: { suggestion: (v) => v === null || isRecord(v) },
    oneOf: { status: ["new", "resolved", "dismissed"] },
  },
];

export function importAll(data: Record<string, unknown>): {
  imported: number;
  counts: Record<string, number>;
} {
  const db = getDb();
  const counts: Record<string, number> = {};
  let imported = 0;

  const insertRows = (spec: (typeof IMPORT_TABLES)[number], rows: unknown[]) => {
    // Unknown keys (a newer build's columns, or anything crafted) are dropped.
    const allowed = tableColumns(spec.table);
    const statements = new Map<string, Database.Statement<unknown[]>>();
    rows.forEach((raw, i) => {
      const where = `Row ${i + 1} of ${spec.key}`;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ImportError(`${where} is not a record`);
      }
      const row = raw as Record<string, unknown>;
      if (!(typeof row.id === "string" && row.id) && typeof row.id !== "number") {
        throw new ImportError(`${where} has no id`);
      }
      const cols = Object.keys(row).filter((c) => allowed.has(c) && row[c] !== undefined);
      const values = cols.map((c) => {
        const v = row[c];
        const shape = spec.json[c];
        if (shape) {
          if (v === null) return null;
          let parsed: unknown = v;
          if (typeof v === "string") {
            try {
              parsed = JSON.parse(v);
            } catch {
              throw new ImportError(`${where} has an unreadable ${c}`);
            }
          }
          if (!shape(parsed)) throw new ImportError(`${where} has an unreadable ${c}`);
          return parsed === null ? null : JSON.stringify(parsed);
        }
        const allowedValues = spec.oneOf[c];
        if (allowedValues && !allowedValues.includes(v as string)) {
          throw new ImportError(`${where} has an unknown ${c}`);
        }
        if (typeof v === "boolean") return v ? 1 : 0;
        if (v !== null && typeof v === "object") return JSON.stringify(v);
        return v;
      });
      const sig = cols.join(",");
      let stmt = statements.get(sig);
      if (!stmt) {
        stmt = db.prepare<unknown[]>(
          `INSERT OR REPLACE INTO ${spec.table}(${cols.map((c) => `"${c}"`).join(",")}) VALUES(${cols.map(() => "?").join(",")})`
        );
        statements.set(sig, stmt);
      }
      try {
        stmt.run(...values);
      } catch (err) {
        throw new ImportError(`${where} could not be imported: ${(err as Error).message}`);
      }
    });
    counts[spec.key] = rows.length;
    imported += rows.length;
  };

  const tx = db.transaction(() => {
    for (const spec of IMPORT_TABLES) {
      const rows = data[spec.key];
      if (rows === undefined || rows === null) continue;
      if (!Array.isArray(rows)) throw new ImportError(`“${spec.key}” in that file is not a list`);
      insertRows(spec, rows);
    }
    // An older file can carry personal subtasks under joint tasks back in.
    alignSubtaskSpaces(db);
  });
  tx();
  return { imported, counts };
}
