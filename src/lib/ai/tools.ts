import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import {
  notesRepo,
  projectsRepo,
  settingsRepo,
  statsRepo,
  tasksRepo,
} from "@/lib/db/repos";
import { getDb } from "@/lib/db";
import { anchorRule, describeRecurrence } from "@/lib/recurrence";
import { addDaysToDateKey, clamp, isoFromLocal, localDateKey, newId, nowIso } from "@/lib/utils";
import type { Priority, RecurrenceRule, Task } from "@/lib/types";
import { asArray, asNumber, asRecord, asString } from "@/lib/ai/json";

// ── Schema shape (subset of JSON Schema both providers accept) ─────────────

export interface JsonSchema {
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  enum?: string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
}

export interface ToolContext {
  tz: string;
  todayKey: string;
  /** client-reported position for this turn, when available */
  location?: { lat: number; lng: number } | null;
  /** ids of tasks complete_task ticked in this turn, so a repeat is ticked once */
  completed?: Set<string>;
}

export interface ToolOutcome {
  /** overrides the pre-computed label once the executor knows more */
  label?: string;
  ok?: boolean;
  payload: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** mutations emit a `tool` SSE pair and land in the message activity log */
  mutating: boolean;
  label(args: Record<string, unknown>, ctx: ToolContext): string;
  run(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome | Promise<ToolOutcome>;
}

// ── Argument helpers ───────────────────────────────────────────────────────

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const v = asString(args[key]);
  if (v === null) return undefined;
  const trimmed = v.trim();
  return trimmed ? trimmed : undefined;
}

function readBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
}

function readPriority(args: Record<string, unknown>): Priority | undefined {
  const n = asNumber(args.priority);
  if (n === null) return undefined;
  return clamp(Math.round(n), 0, 3) as Priority;
}

function readTags(args: Record<string, unknown>): string[] | undefined {
  if (!("tags" in args) || args.tags === undefined || args.tags === null) return undefined;
  if (typeof args.tags === "string") {
    const list = args.tags
      .split(",")
      .map((t) => t.trim().replace(/^#/, ""))
      .filter(Boolean);
    return list;
  }
  return asArray(args.tags)
    .map((t) => (typeof t === "string" ? t.trim().replace(/^#/, "") : ""))
    .filter(Boolean);
}

/**
 * UTC ISO for a local wall-clock moment. `isoFromLocal` goes through TZDate,
 * whose toISOString() emits an offset form ("…-04:00"); the DB stores UTC.
 */
export function utcFromLocal(dateLocal: string, time: string, tz: string): string {
  return new Date(isoFromLocal(dateLocal, time, tz)).toISOString();
}

/** Epoch millis, for comparing stored timestamps regardless of ISO form. */
export function instantOf(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * Models emit due dates in several shapes. Bare dates become all-day local
 * days; zone-less datetimes are read as wall-clock time in the user's tz.
 * Junk reads as "no due date" here; the tools use readDueInput, which keeps
 * junk apart from an explicit clear.
 */
export function parseDueInput(
  raw: unknown,
  tz: string
): { dueAt: string | null; allDay: boolean } | undefined {
  const due = readDueInput(raw, tz);
  return due === "invalid" ? { dueAt: null, allDay: false } : due;
}

/**
 * Like parseDueInput, but a value it cannot read comes back as "invalid".
 * Only null, "" and "none" (or "null", "never") clear the date. The whole
 * string must be a date, or a date and time with an optional zone (Z, UTC,
 * GMT, ±HH[:MM], or the user's own zone name or abbreviation); anything after
 * it is junk, not something to drop. Zone-less times are wall-clock time in
 * `tz`.
 */
export function readDueInput(
  raw: unknown,
  tz: string
): { dueAt: string | null; allDay: boolean } | "invalid" | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return { dueAt: null, allDay: false };
  if (typeof raw !== "string") return "invalid";
  let value = raw.trim();
  if (!value || /^(null|none|never)$/i.test(value)) return { dueAt: null, allDay: false };
  // Naming the user's own zone adds nothing; any other zone name is junk.
  if (value.toLowerCase().endsWith(` ${tz.toLowerCase()}`)) value = value.slice(0, -tz.length).trimEnd();
  // So does the user's own abbreviation at that time (EDT, EST), checked once
  // the wall time is known. Any other abbreviation is junk.
  let abbr: string | undefined;
  const named = /^(\d{4}-\d{2}-\d{2}[T ].*\S)\s+([a-z]{3,5})$/i.exec(value);
  if (named && !/^(utc|gmt)$/i.test(named[2])) {
    value = named[1];
    abbr = named[2].toUpperCase();
  }

  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (dateOnly) {
    if (!isCalendarDate(dateOnly[1])) return "invalid";
    return { dueAt: utcFromLocal(dateOnly[1], "00:00", tz), allDay: true };
  }

  const m =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(?:([ap])\.?m\.?)?\s*(Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?)?$/i.exec(
      value
    );
  if (!m || !isCalendarDate(m[1])) return "invalid";
  let hour = Number(m[2]);
  const minute = Number(m[3]);
  const second = Number(m[4] ?? 0);
  const fraction = m[5] ?? "";
  const meridiem = m[6]?.toLowerCase();
  if (meridiem) {
    if (hour < 1 || hour > 12) return "invalid";
    hour = (hour % 12) + (meridiem === "p" ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || second > 59) return "invalid";
  const zone = m[7];
  if (!zone) {
    const dueAt = utcFromLocal(m[1], `${hour}:${minute}`, tz);
    if (abbr && zoneAbbreviation(dueAt, tz) !== abbr) return "invalid";
    return { dueAt, allDay: false };
  }
  if (abbr) return "invalid";

  const two = (n: number) => String(n).padStart(2, "0");
  const digits = zone.replace(":", "");
  const offset = /^[+-]/.test(zone) ? `${digits.slice(0, 3)}:${digits.slice(3) || "00"}` : "Z";
  // The fraction is kept, so a stored dueAt sent back reads as the same moment.
  const instant = new Date(`${m[1]}T${two(hour)}:${two(minute)}:${two(second)}${fraction}${offset}`);
  if (Number.isNaN(instant.getTime())) return "invalid";
  return { dueAt: instant.toISOString(), allDay: false };
}

/** A YYYY-MM-DD key that names a real day (no Feb 30). */
function isCalendarDate(key: string): boolean {
  const [y, m, d] = key.split("-").map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** The zone's short name at that moment, e.g. "EDT" or "EST" for New York. */
function zoneAbbreviation(iso: string, tz: string): string | undefined {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(new Date(iso))
    .find((p) => p.type === "timeZoneName")
    ?.value.toUpperCase();
}

/**
 * The due moment and all-day flag a create or update ends up with. An
 * all-day task sits at local midnight of its day, and a model's
 * "2026-11-15T00:00:00Z" names Nov 15, not the evening before it.
 */
function resolveDue(
  args: Record<string, unknown>,
  due: { dueAt: string | null; allDay: boolean },
  tz: string
): { dueAt: string | null; allDay: boolean } {
  const allDay = readBoolean(args, "allDay") ?? due.allDay;
  if (!allDay || due.allDay || !due.dueAt) return { dueAt: due.dueAt, allDay };
  const literal = typeof args.dueAt === "string" ? /^\d{4}-\d{2}-\d{2}/.exec(args.dueAt.trim())?.[0] : undefined;
  const key = literal && due.dueAt.endsWith("T00:00:00.000Z") ? literal : localDateKey(due.dueAt, tz);
  return { dueAt: utcFromLocal(key, "00:00", tz), allDay };
}

const DUE_FORMAT_ERROR =
  "Could not read dueAt. Send ISO 8601 like 2026-08-09T15:00, or YYYY-MM-DD for an all-day task, after resolving relative dates such as 'next Friday'.";

function parseRecurrence(raw: unknown): RecurrenceRule | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const rec = asRecord(raw);
  if (!rec) return undefined;
  const freq = asString(rec.freq);
  if (freq !== "daily" && freq !== "weekly" && freq !== "monthly" && freq !== "yearly") {
    return undefined;
  }
  const rule: RecurrenceRule = { freq };
  const interval = asNumber(rec.interval);
  if (interval !== null && interval > 1) rule.interval = Math.round(interval);
  const byWeekday = asArray(rec.byWeekday)
    .map((v) => asNumber(v))
    .filter((n): n is number => n !== null && n >= 0 && n <= 6);
  if (byWeekday.length > 0) rule.byWeekday = byWeekday;
  const byMonthDay = asNumber(rec.byMonthDay);
  if (byMonthDay !== null) rule.byMonthDay = clamp(Math.round(byMonthDay), 1, 31);
  return rule;
}

export function describeDue(iso: string | null, allDay: boolean, tz: string): string {
  if (!iso) return "";
  const todayKey = localDateKey(new Date(), tz);
  const key = localDateKey(iso, tz);
  const zoned = new TZDate(new Date(iso), tz);
  const day =
    key === todayKey
      ? "today"
      : key === addDaysToDateKey(todayKey, 1)
        ? "tomorrow"
        : key === addDaysToDateKey(todayKey, -1)
          ? "yesterday"
          : format(zoned, "EEE MMM d");
  return allDay ? day : `${day} ${format(zoned, "h:mm a")}`;
}

function quote(text: string): string {
  return `“${text}”`;
}

function projectName(projectId: string | null): string | null {
  if (!projectId) return null;
  return projectsRepo.get(projectId)?.name ?? null;
}

/**
 * The project a task is filed into, created when missing. Filing a task into
 * an archived project brings it back, and `note` says so.
 */
function resolveProject(name: string | undefined): { id: string | null; note?: string } {
  if (!name) return { id: null };
  const existing = projectsRepo.findByName(name, { restore: false });
  if (existing?.archived) {
    projectsRepo.update(existing.id, { archived: false });
    return { id: existing.id, note: `Restored archived project ${quote(existing.name)}` };
  }
  if (existing) return { id: existing.id };
  return { id: projectsRepo.create({ name }).id };
}

function compactTask(task: Task, tz: string): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    due: task.dueAt ? describeDue(task.dueAt, task.allDay, tz) : null,
    dueAt: task.dueAt,
    dueKind: task.dueKind,
    list: task.space,
    priority: task.priority,
    project: projectName(task.projectId),
    tags: task.tags,
    repeat: task.recurrence ? describeRecurrence(task.recurrence) : null,
  };
}

function taskLabel(id: string): string {
  const task = tasksRepo.get(id);
  return task ? quote(task.title) : `task ${id}`;
}

function listName(space: "personal" | "joint"): string {
  return space === "joint" ? "the joint list" : "your personal list";
}

const JOINT_PROJECT_NOTE = "Shared tasks can't be in a project, so the project was left off.";

/** The newest Logbook entry for a task, if it has one. */
function latestCompletion(taskId: string): { id: string; completedAt: string } | null {
  const row = getDb()
    .prepare("SELECT id, completed_at FROM completions WHERE task_id=? ORDER BY completed_at DESC LIMIT 1")
    .get(taskId) as { id: string; completed_at: string } | undefined;
  return row ? { id: row.id, completedAt: row.completed_at } : null;
}

// ── Tool definitions ───────────────────────────────────────────────────────

const TASK_FIELDS: Record<string, JsonSchema> = {
  title: { type: "string", description: "Short imperative task title" },
  notes: { type: "string", description: "Optional longer detail" },
  dueAt: {
    type: "string",
    description:
      "Due moment as ISO 8601 (e.g. 2026-08-09T15:00) or YYYY-MM-DD for an all-day task. Use null to clear.",
  },
  space: {
    type: "string",
    enum: ["personal", "joint"],
    description:
      '"joint" = the list shared with the user\'s partner ("our list", "the joint list", "for us"). Default "personal".',
  },
  dueKind: {
    type: "string",
    enum: ["on", "by"],
    description:
      '"by" = deadline: the user said do it BY/BEFORE that date, so it can happen any day up to then and stays on Today with escalating priority. "on" (default) = it happens on that date (appointments, events).',
  },
  allDay: { type: "boolean", description: "True when the task has no specific time" },
  priority: { type: "integer", description: "0 none, 1 low, 2 medium, 3 high", minimum: 0, maximum: 3 },
  projectName: { type: "string", description: "Project name; created when it does not exist" },
  tags: { type: "array", description: "Plain tag words, no # prefix", items: { type: "string" } },
  locationQuery: {
    type: "string",
    description:
      "Real-world place to attach (searched on Google Places), e.g. \"CVS on Main St\". Only when the user names a physical place for the errand.",
  },
  recurrence: {
    type: "object",
    description: "Repeat rule; omit for one-off tasks",
    properties: {
      freq: { type: "string", enum: ["daily", "weekly", "monthly", "yearly"] },
      interval: { type: "integer", description: "Every N units, default 1", minimum: 1 },
      byWeekday: {
        type: "array",
        description: "Weekly only: 0=Sunday … 6=Saturday",
        items: { type: "integer", minimum: 0, maximum: 6 },
      },
      byMonthDay: {
        type: "integer",
        description:
          "Monthly only: day of month. Changing dueAt moves only this occurrence; to change the day it repeats on, send this with the new day.",
        minimum: 1,
        maximum: 31,
      },
    },
    required: ["freq"],
  },
};

export const TOOLS: ToolSpec[] = [
  {
    name: "create_task",
    description:
      "Create a task. Use for anything the user wants to do or be reminded about. Resolve relative dates against today in the user's timezone.",
    parameters: {
      type: "object",
      properties: TASK_FIELDS,
      required: ["title"],
    },
    mutating: true,
    label(args, ctx) {
      const title = readString(args, "title") ?? "task";
      const due = readDueInput(args.dueAt, ctx.tz);
      const when = due && due !== "invalid" ? resolveDue(args, due, ctx.tz) : null;
      const suffix = when?.dueAt ? ` · ${describeDue(when.dueAt, when.allDay, ctx.tz)}` : "";
      return `Added ${quote(title)}${suffix}`;
    },
    async run(args, ctx) {
      const title = readString(args, "title");
      if (!title) return { ok: false, payload: { error: "title is required" } };
      const due = readDueInput(args.dueAt, ctx.tz);
      if (due === "invalid") {
        return {
          ok: false,
          label: `Couldn't read the date for ${quote(title)}`,
          payload: { error: `${DUE_FORMAT_ERROR} The task was not created.` },
        };
      }
      const when = due ? resolveDue(args, due, ctx.tz) : { dueAt: null, allDay: readBoolean(args, "allDay") ?? false };
      const recurrence = parseRecurrence(args.recurrence) ?? null;

      // Best-effort place resolution — a failed lookup never blocks the task.
      let location: Task["location"] = null;
      let locationNote: string | undefined;
      const locationQuery = readString(args, "locationQuery");
      if (locationQuery) {
        try {
          const { searchPlaces } = await import("@/lib/google/places");
          const here = ctx.location ?? (await lastKnownLocation());
          location = (await searchPlaces(locationQuery, here))[0] ?? null;
          if (!location) locationNote = `No place found for "${locationQuery}"`;
        } catch (err) {
          locationNote = err instanceof Error ? err.message : "Place search failed";
        }
      }

      const space = readString(args, "space") === "joint" ? "joint" : "personal";
      const project = readString(args, "projectName");
      const filed = space === "joint" ? { id: null } : resolveProject(project);
      const projectNote = project && space === "joint" ? JOINT_PROJECT_NOTE : filed.note;
      const task = tasksRepo.create({
        title,
        notes: readString(args, "notes") ?? "",
        space,
        dueAt: when.dueAt,
        dueKind: readString(args, "dueKind") === "by" ? "by" : "on",
        allDay: when.allDay,
        priority: readPriority(args) ?? 0,
        projectId: filed.id,
        tags: readTags(args) ?? [],
        recurrence:
          recurrence && when.dueAt ? anchorRule(recurrence, new Date(when.dueAt), ctx.tz) : recurrence,
        location,
      });
      const placeSuffix = location ? ` · 📍 ${location.name}` : "";
      return {
        label: `Added ${quote(task.title)}${task.dueAt ? ` · ${describeDue(task.dueAt, task.allDay, ctx.tz)}` : ""}${placeSuffix}`,
        payload: { created: compactTask(task, ctx.tz), locationNote, projectNote },
      };
    },
  },

  {
    name: "update_task",
    description:
      "Change fields on an existing task. Only include the fields that change. The id must come from the task list or a previous tool result. On a repeating task a new dueAt moves only this occurrence; to change the day a monthly task repeats on, also send recurrence with the new byMonthDay.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Existing task id" }, ...TASK_FIELDS },
      required: ["id"],
    },
    mutating: true,
    label(args) {
      const id = readString(args, "id");
      return `Updated ${id ? taskLabel(id) : "task"}`;
    },
    run(args, ctx) {
      const id = readString(args, "id");
      if (!id) return { ok: false, payload: { error: "id is required" } };
      const existing = tasksRepo.get(id);
      if (!existing) {
        return { ok: false, label: `Task ${id} not found`, payload: { error: "No task with that id" } };
      }
      const due = readDueInput(args.dueAt, ctx.tz);
      if (due === "invalid") {
        return {
          ok: false,
          label: `Couldn't read the date for ${quote(existing.title)}`,
          payload: { error: `${DUE_FORMAT_ERROR} The task was not changed.` },
        };
      }
      const spaceArg = readString(args, "space");
      const space = spaceArg === "joint" || spaceArg === "personal" ? spaceArg : undefined;
      if (space && space !== existing.space && existing.parentId) {
        return {
          ok: false,
          label: `Couldn't move ${quote(existing.title)} to ${listName(space)}`,
          payload: {
            error: "A subtask stays on its parent's list. Move the parent task instead. Nothing was changed.",
          },
        };
      }
      const patch: Parameters<typeof tasksRepo.update>[1] = {};
      const title = readString(args, "title");
      if (title) patch.title = title;
      const notes = asString(args.notes);
      if (notes !== null) patch.notes = notes;
      if (due) {
        const when = resolveDue(args, due, ctx.tz);
        patch.dueAt = when.dueAt;
        patch.allDay = when.allDay;
      } else {
        const allDay = readBoolean(args, "allDay");
        if (allDay !== undefined) patch.allDay = allDay;
      }
      const dueKind = readString(args, "dueKind");
      if (dueKind === "by" || dueKind === "on") patch.dueKind = dueKind;
      if (space && space !== existing.space) patch.space = space;
      const priority = readPriority(args);
      if (priority !== undefined) patch.priority = priority;
      const project = readString(args, "projectName");
      let projectNote: string | undefined;
      if (project !== undefined) {
        if ((patch.space ?? existing.space) === "joint") projectNote = JOINT_PROJECT_NOTE;
        else {
          const filed = resolveProject(project);
          patch.projectId = filed.id;
          projectNote = filed.note;
        }
      }
      const tags = readTags(args);
      if (tags !== undefined) patch.tags = tags;
      const recurrence = parseRecurrence(args.recurrence);
      if (recurrence !== undefined) patch.recurrence = recurrence;
      if ("recurrence" in patch || "dueAt" in patch) {
        // Pin the anchor day so a short month never shifts later repeats.
        let rule = "recurrence" in patch ? patch.recurrence : existing.recurrence;
        const pinned = existing.recurrence?.byMonthDay;
        if (rule && recurrence && recurrence.byMonthDay === undefined && pinned && existing.recurrence?.freq === rule.freq) {
          // A resent rule of the same kind keeps the day it was pinned to.
          rule = { ...rule, byMonthDay: pinned };
          patch.recurrence = rule;
        }
        const dueAt = "dueAt" in patch ? patch.dueAt : existing.dueAt;
        // A new dueAt moves only this occurrence, so a stored day stays put;
        // the model sends recurrence.byMonthDay to change it. A rule with no
        // day yet takes it from the date.
        if (rule && dueAt && ("recurrence" in patch || !rule.byMonthDay)) {
          const anchored = anchorRule(rule, new Date(dueAt), ctx.tz);
          if ("recurrence" in patch || JSON.stringify(anchored) !== JSON.stringify(rule)) {
            patch.recurrence = anchored;
          }
        }
      }

      if (Object.keys(patch).length === 0) {
        return {
          label: `No changes to ${quote(existing.title)}`,
          payload: { unchanged: compactTask(existing, ctx.tz), note: projectNote ?? "The task already matches" },
        };
      }
      const task = tasksRepo.update(id, patch);
      if (!task) return { ok: false, payload: { error: "Update failed" } };
      if (patch.space && task.space !== patch.space) {
        return {
          ok: false,
          label: `Couldn't move ${quote(task.title)} to ${listName(patch.space)}`,
          payload: {
            error: "Moving the task between lists failed. Any other changes were saved.",
            updated: compactTask(task, ctx.tz),
          },
        };
      }
      return {
        label: `Updated ${quote(task.title)}`,
        payload: { updated: compactTask(task, ctx.tz), projectNote },
      };
    },
  },

  {
    name: "complete_task",
    description:
      "Mark a task done, or reopen it with done=false. A repeating task stays open: done=false removes its latest completion and keeps its next date.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Existing task id" },
        done: { type: "boolean", description: "Defaults to true" },
        expectedDueAt: {
          type: "string",
          description:
            "The task's dueAt as you last saw it. A repeating task that has moved past it since is not ticked again.",
        },
      },
      required: ["id"],
    },
    mutating: true,
    label(args) {
      const id = readString(args, "id");
      const done = readBoolean(args, "done") ?? true;
      return `${done ? "Completed" : "Reopened"} ${id ? taskLabel(id) : "task"}`;
    },
    run(args, ctx) {
      const id = readString(args, "id");
      if (!id) return { ok: false, payload: { error: "id is required" } };
      const done = readBoolean(args, "done") ?? true;
      const before = tasksRepo.get(id);
      if (!before) {
        return { ok: false, label: `Task ${id} not found`, payload: { error: "No task with that id" } };
      }
      if (done && before.status === "done") {
        return {
          label: `${quote(before.title)} was already done`,
          payload: { task: compactTask(before, ctx.tz), alreadyDone: true },
        };
      }
      const repeating = !!before.recurrence && !before.parentId;
      const alreadyTicked = (task: Task, note: string): ToolOutcome => ({
        label: `${quote(task.title)} was already ticked${task.dueAt ? ` · next ${describeDue(task.dueAt, task.allDay, ctx.tz)}` : ""}`,
        payload: { task: compactTask(task, ctx.tz), alreadyDone: true, note },
      });
      if (done && repeating && ctx.completed?.has(id)) {
        return alreadyTicked(before, "It was already completed earlier in this turn, so it was not ticked again.");
      }
      if (!done && before.status === "open") {
        if (repeating) {
          // A repeating task never closes, so undoing a tick means taking its
          // latest Logbook entry back out. The next date stays as it is.
          const latest = latestCompletion(before.id);
          const undone = latest ? tasksRepo.unlog(latest.id) : null;
          if (!latest || !undone?.removed) {
            return {
              ok: false,
              label: `Can't reopen ${quote(before.title)}`,
              payload: {
                error:
                  "This task repeats and has no completion to remove, so it is already open. update_task can change its due date.",
                task: compactTask(before, ctx.tz),
              },
            };
          }
          ctx.completed?.delete(id);
          const task = undone.task ?? before;
          const next = task.dueAt ? ` · next ${describeDue(task.dueAt, task.allDay, ctx.tz)}` : "";
          return {
            label: `Removed the last completion of ${quote(task.title)}${next}`,
            payload: {
              task: compactTask(task, ctx.tz),
              removedCompletion: describeDue(latest.completedAt, false, ctx.tz),
              note: "A repeating task stays open, and its next date is unchanged.",
            },
          };
        }
        return {
          label: `${quote(before.title)} is already open`,
          payload: { task: compactTask(before, ctx.tz), alreadyOpen: true },
        };
      }
      const expected = readDueInput(args.expectedDueAt, ctx.tz);
      const { task, recurred, changed } = tasksRepo.setDone(id, done, {
        expectedDueAt: expected && expected !== "invalid" ? expected.dueAt : undefined,
      });
      if (!task) return { ok: false, payload: { error: "No task with that id" } };
      if (!changed) {
        if (done && repeating) {
          return alreadyTicked(task, "Its due date has moved past expectedDueAt, so it was not ticked again.");
        }
        return {
          label: `${quote(task.title)} ${done ? "was already done" : "is already open"}`,
          payload: { task: compactTask(task, ctx.tz), changed: false },
        };
      }
      if (done) ctx.completed?.add(id);
      else ctx.completed?.delete(id);
      const nextDue = recurred && task.dueAt ? describeDue(task.dueAt, task.allDay, ctx.tz) : "";
      return {
        label: recurred
          ? `Completed ${quote(task.title)} · next ${nextDue}`
          : `${done ? "Completed" : "Reopened"} ${quote(task.title)}`,
        payload: {
          task: compactTask(task, ctx.tz),
          recurred,
          nextDueAt: recurred ? task.dueAt : null,
        },
      };
    },
  },

  {
    name: "delete_task",
    description: "Permanently delete a task. Prefer complete_task when the user finished it.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "Existing task id" } },
      required: ["id"],
    },
    mutating: true,
    label(args) {
      const id = readString(args, "id");
      return `Deleted ${id ? taskLabel(id) : "task"}`;
    },
    run(args) {
      const id = readString(args, "id");
      if (!id) return { ok: false, payload: { error: "id is required" } };
      const existing = tasksRepo.get(id);
      if (!existing) {
        return { ok: false, label: `Task ${id} not found`, payload: { error: "No task with that id" } };
      }
      tasksRepo.remove(id);
      return { label: `Deleted ${quote(existing.title)}`, payload: { deleted: id } };
    },
  },

  {
    name: "list_tasks",
    description:
      "Look up tasks. Use it before updating or completing anything so you have real ids. view=today covers today plus overdue.",
    parameters: {
      type: "object",
      properties: {
        view: { type: "string", enum: ["today", "upcoming", "anytime", "all"] },
        q: { type: "string", description: "Text search over title and notes" },
        projectName: { type: "string" },
        tag: { type: "string", description: "Plain tag word, no # prefix" },
        list: {
          type: "string",
          enum: ["personal", "joint"],
          description: 'Which list to search. "joint" = the shared list. Default personal.',
        },
        includeDone: { type: "boolean" },
      },
    },
    mutating: false,
    label() {
      return "Checked tasks";
    },
    run(args, ctx) {
      const viewRaw = readString(args, "view");
      const view =
        viewRaw === "today" || viewRaw === "upcoming" || viewRaw === "anytime" || viewRaw === "all"
          ? viewRaw
          : undefined;
      const projectNameArg = readString(args, "projectName");
      const project = projectNameArg
        ? projectsRepo.findByName(projectNameArg, { restore: false })
        : null;
      if (projectNameArg && !project) {
        return { payload: { count: 0, tasks: [], note: `No project named ${projectNameArg}` } };
      }
      const tasks = tasksRepo.list({
        view,
        q: readString(args, "q"),
        projectId: project?.id,
        tag: readString(args, "tag")?.replace(/^#/, "") || undefined,
        space: readString(args, "list") === "joint" ? "joint" : "personal",
        includeDone: readBoolean(args, "includeDone") ?? false,
      });
      const trimmed = tasks.slice(0, 60);
      return {
        payload: {
          count: tasks.length,
          tasks: trimmed.map((t) => compactTask(t, ctx.tz)),
        },
      };
    },
  },

  {
    name: "create_project",
    description: "Create a project (a list/area tasks can belong to).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        icon: { type: "string", description: "A single emoji" },
        color: { type: "string", description: "Hex colour like #FFA94D" },
      },
      required: ["name"],
    },
    mutating: true,
    label(args) {
      return `Created project ${quote(readString(args, "name") ?? "project")}`;
    },
    run(args) {
      const name = readString(args, "name");
      if (!name) return { ok: false, payload: { error: "name is required" } };
      const existing = projectsRepo.findByName(name, { restore: false });
      if (existing?.archived) {
        projectsRepo.update(existing.id, { archived: false });
        return {
          label: `Restored archived project ${quote(existing.name)}`,
          payload: { project: { id: existing.id, name: existing.name }, created: false, restored: true },
        };
      }
      if (existing) {
        return {
          label: `Project ${quote(existing.name)} already existed`,
          payload: { project: { id: existing.id, name: existing.name }, created: false },
        };
      }
      const project = projectsRepo.create({
        name,
        icon: readString(args, "icon"),
        color: readString(args, "color"),
      });
      return {
        label: `Created project ${quote(project.name)}`,
        payload: { project: { id: project.id, name: project.name }, created: true },
      };
    },
  },

  {
    name: "add_note",
    description:
      "Save a note. When a note with the same title exists the content is appended to it (checklist notes gain the lines as items).",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string", description: "Body text; one item per line for checklists" },
        kind: { type: "string", enum: ["note", "checklist"] },
      },
      required: ["title", "content"],
    },
    mutating: true,
    label(args) {
      return `Saved note ${quote(readString(args, "title") ?? "note")}`;
    },
    run(args) {
      const title = readString(args, "title");
      const content = asString(args.content)?.trim() ?? "";
      if (!title) return { ok: false, payload: { error: "title is required" } };
      const kind = readString(args, "kind") === "checklist" ? "checklist" : "note";
      const existing = notesRepo.findByTitle(title);

      if (existing) {
        if (existing.kind === "checklist") {
          const items = [
            ...existing.items,
            ...splitLines(content).map((text) => ({ id: newId(), text, done: false })),
          ];
          notesRepo.update(existing.id, { items });
          return {
            label: `Added to checklist ${quote(existing.title)}`,
            payload: { noteId: existing.id, appended: true, items: items.length },
          };
        }
        const merged = existing.content ? `${existing.content}\n\n${content}` : content;
        notesRepo.update(existing.id, { content: merged });
        return {
          label: `Appended to note ${quote(existing.title)}`,
          payload: { noteId: existing.id, appended: true },
        };
      }

      const note = notesRepo.create({
        title,
        kind,
        content: kind === "checklist" ? "" : content,
        items:
          kind === "checklist"
            ? splitLines(content).map((text) => ({ id: newId(), text, done: false }))
            : [],
      });
      return {
        label: `Saved ${kind === "checklist" ? "checklist" : "note"} ${quote(note.title)}`,
        payload: { noteId: note.id, created: true },
      };
    },
  },

  {
    name: "append_checklist",
    description:
      "Add unchecked items to a checklist note, creating the checklist when missing. On a plain note the items are added as new lines.",
    parameters: {
      type: "object",
      properties: {
        noteTitle: { type: "string" },
        items: { type: "array", items: { type: "string" } },
      },
      required: ["noteTitle", "items"],
    },
    mutating: true,
    label(args) {
      const items = asArray(args.items).length;
      return `Added ${items} item${items === 1 ? "" : "s"} to ${quote(readString(args, "noteTitle") ?? "checklist")}`;
    },
    run(args) {
      const title = readString(args, "noteTitle");
      if (!title) return { ok: false, payload: { error: "noteTitle is required" } };
      const texts = asArray(args.items)
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .filter(Boolean);
      if (texts.length === 0) return { ok: false, payload: { error: "items is empty" } };
      const fresh = texts.map((text) => ({ id: newId(), text, done: false }));
      const existing = notesRepo.findByTitle(title);
      if (existing && existing.kind !== "checklist" && existing.content.trim()) {
        // A plain note keeps its kind: a checklist would hide its text.
        const body = existing.content.trimEnd();
        const bullet = /^\s*[-*•]\s+/.exec(body.split("\n").pop() ?? "")?.[0] ?? "";
        const content = `${body}\n${texts.map((text) => `${bullet}${text}`).join("\n")}`;
        notesRepo.update(existing.id, { content });
        return {
          label: `Added ${texts.length} item${texts.length === 1 ? "" : "s"} to ${quote(existing.title)}`,
          payload: { noteId: existing.id, added: texts.length, kind: "note" },
        };
      }
      if (existing) {
        notesRepo.update(existing.id, { kind: "checklist", items: [...existing.items, ...fresh] });
        return {
          label: `Added ${texts.length} item${texts.length === 1 ? "" : "s"} to ${quote(existing.title)}`,
          payload: { noteId: existing.id, added: texts.length },
        };
      }
      const note = notesRepo.create({ title, kind: "checklist", items: fresh });
      return {
        label: `Created checklist ${quote(note.title)} with ${texts.length} item${texts.length === 1 ? "" : "s"}`,
        payload: { noteId: note.id, added: texts.length, created: true },
      };
    },
  },

  {
    name: "list_notes",
    description: "Search saved notes and checklists.",
    parameters: {
      type: "object",
      properties: { q: { type: "string", description: "Optional search text" } },
    },
    mutating: false,
    label() {
      return "Checked notes";
    },
    run(args) {
      const notes = notesRepo.list({ q: readString(args, "q") }).slice(0, 30);
      return {
        payload: {
          count: notes.length,
          notes: notes.map((n) => ({
            id: n.id,
            title: n.title,
            kind: n.kind,
            content: n.kind === "note" ? n.content.slice(0, 400) : undefined,
            items: n.kind === "checklist" ? n.items.map((i) => `${i.done ? "x" : " "} ${i.text}`) : undefined,
          })),
        },
      };
    },
  },

  {
    name: "get_calendar_today",
    description: "Read today's calendar events from the connected Google Calendar.",
    parameters: { type: "object", properties: {} },
    mutating: false,
    label() {
      return "Checked calendar";
    },
    async run(_args, ctx) {
      try {
        // Imported lazily: the Google module is server-only, the registry is not.
        const { getTodayEvents } = await import("@/lib/google/calendar");
        const events = await getTodayEvents();
        return {
          payload: {
            count: events.length,
            events: events.map((e) => ({
              title: e.title,
              start: e.allDay ? "all day" : describeDue(e.start, false, ctx.tz),
              end: e.allDay ? "all day" : describeDue(e.end, false, ctx.tz),
              location: e.location,
            })),
          },
        };
      } catch {
        return { payload: { count: 0, events: [], note: "Calendar is not connected" } };
      }
    },
  },

  {
    name: "get_nearby_errands",
    description:
      "Open tasks that have a place attached, sorted by distance from the user's current position. Use during walks or when the user asks what's nearby / on their route.",
    parameters: { type: "object", properties: {} },
    mutating: false,
    label() {
      return "Checked nearby errands";
    },
    async run(_args, ctx) {
      const located = tasksRepo.located();
      if (located.length === 0) {
        return { payload: { count: 0, note: "No tasks have locations attached yet" } };
      }
      const here = ctx.location ?? (await lastKnownLocation());
      if (!here) {
        return {
          payload: {
            count: located.length,
            note: "The user's current position is unknown — list places without distances",
            errands: located.map((t) => ({ title: t.title, place: t.location!.name })),
          },
        };
      }
      const { haversineKm, distanceLabel } = await import("@/lib/utils");
      const errands = located
        .map((t) => ({ task: t, km: haversineKm(here, t.location!) }))
        .sort((a, b) => a.km - b.km)
        .slice(0, 10)
        .map(({ task, km }) => ({
          id: task.id,
          title: task.title,
          place: task.location!.name,
          address: task.location!.address,
          distance: distanceLabel(km),
          withinWalk: km <= 1.6,
        }));
      return { payload: { count: errands.length, errands } };
    },
  },

  {
    name: "set_task_location",
    description:
      "Attach a real-world place to an existing task (or change it) by searching Google Places, e.g. \"CVS on Main Street\". Requires the Maps key in Settings.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Existing task id" },
        query: { type: "string", description: "Place to search for, include city/street when known" },
      },
      required: ["id", "query"],
    },
    mutating: true,
    label(args) {
      const q = readString(args, "query") ?? "location";
      return `Set location · ${q}`;
    },
    async run(args, ctx) {
      const id = readString(args, "id");
      const query = readString(args, "query");
      if (!id || !query) return { ok: false, payload: { error: "id and query are required" } };
      const task = tasksRepo.get(id);
      if (!task) return { ok: false, payload: { error: "No task with that id" } };
      try {
        // Imported lazily: the Google module is server-only, the registry is not.
        const { searchPlaces } = await import("@/lib/google/places");
        const here = ctx.location ?? (await lastKnownLocation());
        const results = await searchPlaces(query, here);
        const place = results[0];
        if (!place) {
          return { ok: false, payload: { error: `No place found for "${query}"` } };
        }
        tasksRepo.update(id, { location: place });
        return {
          label: `Pinned ${quote(task.title)} to ${place.name}`,
          payload: { attached: { name: place.name, address: place.address } },
        };
      } catch (err) {
        return {
          ok: false,
          payload: { error: err instanceof Error ? err.message : "Place search failed" },
        };
      }
    },
  },

  {
    name: "get_stats",
    description: "Completion streak, today's counts and the last 7 days of activity.",
    parameters: { type: "object", properties: {} },
    mutating: false,
    label() {
      return "Checked stats";
    },
    run() {
      return { payload: statsRepo.summary() };
    },
  },

];

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);
}

// ── Provider schema mapping ────────────────────────────────────────────────

export interface OpenAiTool {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export function toOpenAiTools(tools: ToolSpec[]): OpenAiTool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: normalizeSchema(t.parameters) },
  }));
}

export function toAnthropicTools(tools: ToolSpec[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: normalizeSchema(t.parameters),
  }));
}

/** Both providers require top-level `type: "object"` with a properties bag. */
function normalizeSchema(schema: JsonSchema): JsonSchema {
  return { type: "object", properties: {}, ...schema };
}

export function findTool(name: string): ToolSpec | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function toolContext(
  tz: string,
  location?: { lat: number; lng: number } | null,
): ToolContext {
  return { tz, todayKey: localDateKey(new Date(), tz), location: location ?? null, completed: new Set() };
}

/** Falls back to the most recent client-reported position (< 2h old). */
async function lastKnownLocation(): Promise<{ lat: number; lng: number } | null> {
  const last = settingsRepo.getApp().lastLocation;
  if (!last) return null;
  const age = Date.now() - Date.parse(last.at);
  if (!Number.isFinite(age) || age > 2 * 60 * 60 * 1000) return null;
  return { lat: last.lat, lng: last.lng };
}
