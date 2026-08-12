import { getDb } from "@/lib/db";
import { newId, nowIso, localDateKey, addDaysToDateKey, isoFromLocal } from "@/lib/utils";
import { nextOccurrence } from "@/lib/recurrence";
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
  DayPlan,
  Project,
  StatsSummary,
  Task,
  TaskDraft,
  TaskListFilter,
  TaskPatch,
  ToolActivity,
  TriageFeedback,
  WeeklyReview,
} from "@/lib/types";
import crypto from "crypto";

// ── Settings ───────────────────────────────────────────────────────────────

export const DEFAULT_SETTINGS: AppSettings = {
  pinHash: "",
  tz: "America/New_York",
  theme: "system",
  ai: {
    provider: "openai",
    model: "",
    openaiKey: "",
    anthropicKey: "",
    customBaseUrl: "",
    customKey: "",
    customModel: "",
  },
  voice: { voiceURI: "", rate: 1, autoListen: true },
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
  lastLocation: null,
  ingestToken: "",
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
  create(userAgent: string): string {
    const token = crypto.randomBytes(32).toString("hex");
    getDb()
      .prepare("INSERT INTO sessions(token, created_at, last_seen_at, user_agent) VALUES(?,?,?,?)")
      .run(token, nowIso(), nowIso(), userAgent.slice(0, 300));
    return token;
  },
  verify(token: string): boolean {
    if (!token) return false;
    const row = getDb().prepare("SELECT token FROM sessions WHERE token=?").get(token);
    if (!row) return false;
    getDb().prepare("UPDATE sessions SET last_seen_at=? WHERE token=?").run(nowIso(), token);
    return true;
  },
  destroy(token: string): void {
    getDb().prepare("DELETE FROM sessions WHERE token=?").run(token);
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
  priority: number;
  due_at: string | null;
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
    priority: r.priority as Task["priority"],
    dueAt: r.due_at,
    allDay: !!r.all_day,
    projectId: r.project_id,
    tags: JSON.parse(r.tags || "[]"),
    parentId: r.parent_id,
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

    const where: string[] = ["parent_id IS NULL"];
    const params: unknown[] = [];

    if (filter.view === "today") {
      // open tasks due before tomorrow (i.e. today + overdue)
      if (filter.includeDone) {
        where.push(
          "((status='open' AND due_at IS NOT NULL AND due_at < ?) OR (status='done' AND completed_at >= ?))"
        );
        params.push(tomorrowStartIso, isoStartOfLocalDay(todayKey, tz));
      } else {
        where.push("status='open' AND due_at IS NOT NULL AND due_at < ?");
        params.push(tomorrowStartIso);
      }
    } else if (filter.view === "upcoming") {
      where.push("status='open' AND due_at IS NOT NULL AND due_at >= ?");
      params.push(tomorrowStartIso);
    } else if (filter.view === "anytime") {
      where.push("status='open' AND due_at IS NULL");
    } else if (!filter.includeDone) {
      where.push("status='open'");
    }

    if (filter.projectId) {
      where.push("project_id = ?");
      params.push(filter.projectId);
    }
    if (filter.tag) {
      where.push("tags LIKE ?");
      params.push(`%${JSON.stringify(filter.tag)}%`);
    }
    if (filter.q) {
      where.push("(title LIKE ? OR notes LIKE ?)");
      params.push(`%${filter.q}%`, `%${filter.q}%`);
    }
    if (filter.dueBefore) {
      where.push("due_at IS NOT NULL AND due_at < ?");
      params.push(filter.dueBefore);
    }

    const rows = getDb()
      .prepare(`SELECT * FROM tasks WHERE ${where.join(" AND ")} ${TASK_ORDER} LIMIT 500`)
      .all(...params) as TaskRow[];
    return attachSubtasks(rows.map(rowToTask));
  },

  create(draft: TaskDraft): Task {
    const id = newId();
    const now = nowIso();
    getDb()
      .prepare(
        `INSERT INTO tasks(id,title,notes,status,priority,due_at,all_day,project_id,tags,parent_id,recurrence,location,sort,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        draft.title.trim(),
        draft.notes ?? "",
        "open",
        draft.priority ?? 0,
        draft.dueAt ?? null,
        draft.allDay ? 1 : 0,
        draft.projectId ?? null,
        JSON.stringify(draft.tags ?? []),
        draft.parentId ?? null,
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
    const sets: string[] = ["updated_at=?"];
    const params: unknown[] = [nowIso()];
    const map: [keyof TaskPatch, string, (v: unknown) => unknown][] = [
      ["title", "title", (v) => String(v).trim()],
      ["notes", "notes", (v) => v],
      ["priority", "priority", (v) => v],
      ["dueAt", "due_at", (v) => v],
      ["allDay", "all_day", (v) => (v ? 1 : 0)],
      ["projectId", "project_id", (v) => v],
      ["tags", "tags", (v) => JSON.stringify(v ?? [])],
      ["parentId", "parent_id", (v) => v],
      ["recurrence", "recurrence", (v) => (v ? JSON.stringify(v) : null)],
      ["location", "location", (v) => (v ? JSON.stringify(v) : null)],
      ["sort", "sort", (v) => v],
    ];
    for (const [key, col, conv] of map) {
      if (key in patch) {
        sets.push(`${col}=?`);
        params.push(conv(patch[key]));
      }
    }
    if ("dueAt" in patch) {
      sets.push("notified_at=NULL");
    }
    params.push(id);
    getDb().prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id=?`).run(...params);
    return this.get(id);
  },

  remove(id: string): void {
    const db = getDb();
    db.prepare("DELETE FROM tasks WHERE parent_id=?").run(id);
    db.prepare("DELETE FROM tasks WHERE id=?").run(id);
  },

  /**
   * Complete / un-complete. For recurring top-level tasks, completion logs the
   * occurrence and advances due_at to the next occurrence (task stays open).
   */
  setDone(id: string, done: boolean): { task: Task | null; recurred: boolean } {
    const task = this.get(id);
    if (!task) return { task: null, recurred: false };
    const settings = settingsRepo.getApp();
    const now = nowIso();
    const db = getDb();

    if (done) {
      if (task.recurrence && !task.parentId && task.dueAt) {
        const next = nextOccurrence(task.recurrence, new Date(task.dueAt), settings.tz);
        completionsRepo.log(task.id, task.title, now, localDateKey(now, settings.tz));
        db.prepare("UPDATE tasks SET due_at=?, notified_at=NULL, updated_at=? WHERE id=?").run(
          next.toISOString(),
          now,
          id
        );
        return { task: this.get(id), recurred: true };
      }
      completionsRepo.log(task.id, task.title, now, localDateKey(now, settings.tz));
      db.prepare("UPDATE tasks SET status='done', completed_at=?, updated_at=? WHERE id=?").run(
        now,
        now,
        id
      );
      return { task: this.get(id), recurred: false };
    }

    completionsRepo.removeLatestForTask(id);
    db.prepare("UPDATE tasks SET status='open', completed_at=NULL, updated_at=? WHERE id=?").run(
      now,
      id
    );
    return { task: this.get(id), recurred: false };
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

  /** Open, top-level tasks that carry a location. */
  located(): Task[] {
    const rows = getDb()
      .prepare(
        "SELECT * FROM tasks WHERE status='open' AND parent_id IS NULL AND location IS NOT NULL LIMIT 200"
      )
      .all() as TaskRow[];
    return rows.map(rowToTask);
  },

  allTags(): string[] {
    const rows = getDb()
      .prepare("SELECT tags FROM tasks WHERE status='open'")
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
        .prepare("SELECT COUNT(*) c FROM tasks WHERE status='open' AND parent_id IS NULL")
        .get() as { c: number }
    ).c;
    const overdue = (
      getDb()
        .prepare(
          "SELECT COUNT(*) c FROM tasks WHERE status='open' AND parent_id IS NULL AND due_at IS NOT NULL AND due_at < ?"
        )
        .get(startToday) as { c: number }
    ).c;
    return { open, overdue };
  },
};

function isoStartOfLocalDay(dateKey: string, tz: string): string {
  return isoFromLocal(dateKey, "00:00", tz);
}

// ── Completions / stats ────────────────────────────────────────────────────

export const completionsRepo = {
  log(taskId: string, title: string, completedAt: string, dateLocal: string): void {
    getDb()
      .prepare(
        "INSERT INTO completions(id, task_id, title, completed_at, date_local) VALUES(?,?,?,?,?)"
      )
      .run(newId(), taskId, title, completedAt, dateLocal);
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
        "SELECT date_local, COUNT(*) c FROM completions WHERE date_local >= ? AND date_local <= ? GROUP BY date_local"
      )
      .all(fromKey, toKey) as { date_local: string; c: number }[];
    return new Map(rows.map((r) => [r.date_local, r.c]));
  },
  countRange(fromKey: string, toKey: string): number {
    const row = getDb()
      .prepare("SELECT COUNT(*) c FROM completions WHERE date_local >= ? AND date_local <= ?")
      .get(fromKey, toKey) as { c: number };
    return row.c;
  },
  /** Completed entries grouped newest-day-first for the Logbook. */
  logbook(fromKey: string, toKey: string): { dateLocal: string; entries: { taskId: string; title: string; completedAt: string }[] }[] {
    const rows = getDb()
      .prepare(
        "SELECT task_id, title, completed_at, date_local FROM completions WHERE date_local >= ? AND date_local <= ? ORDER BY completed_at DESC LIMIT 500"
      )
      .all(fromKey, toKey) as { task_id: string; title: string; completed_at: string; date_local: string }[];
    const byDay = new Map<string, { taskId: string; title: string; completedAt: string }[]>();
    for (const r of rows) {
      const list = byDay.get(r.date_local) ?? [];
      list.push({ taskId: r.task_id, title: r.title, completedAt: r.completed_at });
      byDay.set(r.date_local, list);
    }
    return [...byDay.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([dateLocal, entries]) => ({ dateLocal, entries }));
  },

  listRange(fromKey: string, toKey: string): { title: string; dateLocal: string }[] {
    const rows = getDb()
      .prepare(
        "SELECT title, date_local FROM completions WHERE date_local >= ? AND date_local <= ? ORDER BY completed_at ASC"
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
  findByName(name: string): Project | null {
    const r = getDb()
      .prepare("SELECT * FROM projects WHERE lower(name)=lower(?) AND archived=0")
      .get(name.trim()) as ProjectRow | undefined;
    return r ? this.get(r.id) : null;
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
      where.push("(title LIKE ? OR content LIKE ? OR items LIKE ?)");
      params.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`);
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
    const r = getDb()
      .prepare("SELECT * FROM notes WHERE lower(title)=lower(?) AND archived=0")
      .get(title.trim()) as NoteRow | undefined;
    return r ? rowToNote(r) : null;
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
        ? getDb().prepare("SELECT * FROM inbox_items ORDER BY received_at DESC LIMIT 100").all()
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

export const plansRepo = {
  get(dateLocal: string): DayPlan | null {
    const r = getDb().prepare("SELECT * FROM plans WHERE date_local=?").get(dateLocal) as
      | { date_local: string; summary: string; blocks: string; accepted: number; generated_at: string }
      | undefined;
    if (!r) return null;
    return {
      dateLocal: r.date_local,
      summary: r.summary,
      blocks: JSON.parse(r.blocks || "[]"),
      accepted: !!r.accepted,
      generatedAt: r.generated_at,
    };
  },
  save(plan: DayPlan): void {
    getDb()
      .prepare(
        `INSERT INTO plans(date_local,summary,blocks,accepted,generated_at) VALUES(?,?,?,?,?)
         ON CONFLICT(date_local) DO UPDATE SET summary=excluded.summary, blocks=excluded.blocks,
         accepted=excluded.accepted, generated_at=excluded.generated_at`
      )
      .run(plan.dateLocal, plan.summary, JSON.stringify(plan.blocks), plan.accepted ? 1 : 0, plan.generatedAt);
  },
};

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
        "SELECT * FROM (SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC"
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
  add(subscription: { endpoint: string } & Record<string, unknown>): void {
    getDb()
      .prepare(
        `INSERT INTO push_subscriptions(endpoint,subscription,created_at) VALUES(?,?,?)
         ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription`
      )
      .run(subscription.endpoint, JSON.stringify(subscription), nowIso());
  },
  list(): { endpoint: string; subscription: Record<string, unknown> }[] {
    const rows = getDb().prepare("SELECT * FROM push_subscriptions").all() as {
      endpoint: string;
      subscription: string;
    }[];
    return rows.map((r) => ({ endpoint: r.endpoint, subscription: JSON.parse(r.subscription) }));
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

export function importAll(data: Record<string, unknown>): { imported: number } {
  const db = getDb();
  let imported = 0;
  const insertRows = (table: string, rows: unknown[]) => {
    for (const row of rows as Record<string, unknown>[]) {
      const cols = Object.keys(row);
      const stmt = db.prepare(
        `INSERT OR REPLACE INTO ${table}(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`
      );
      stmt.run(...cols.map((c) => row[c]));
      imported++;
    }
  };
  const tx = db.transaction(() => {
    for (const table of ["tasks", "projects", "notes", "completions"]) {
      if (Array.isArray(data[table])) insertRows(table, data[table] as unknown[]);
    }
  });
  tx();
  return { imported };
}
