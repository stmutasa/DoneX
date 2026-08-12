import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import {
  notesRepo,
  plansRepo,
  projectsRepo,
  settingsRepo,
  statsRepo,
  tasksRepo,
} from "@/lib/db/repos";
import { addDaysToDateKey, clamp, isoFromLocal, localDateKey, newId, nowIso } from "@/lib/utils";
import type { PlanBlock, Priority, RecurrenceRule, Task } from "@/lib/types";
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
 */
export function parseDueInput(
  raw: unknown,
  tz: string
): { dueAt: string | null; allDay: boolean } | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return { dueAt: null, allDay: false };
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || /^(null|none|never)$/i.test(value)) return { dueAt: null, allDay: false };

  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (dateOnly) return { dueAt: utcFromLocal(dateOnly[1], "00:00", tz), allDay: true };

  const naive = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(value);
  const zoned = /(Z|z|[+-]\d{2}:?\d{2})$/.test(value);
  if (naive && !zoned) return { dueAt: utcFromLocal(naive[1], naive[2], tz), allDay: false };

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { dueAt: null, allDay: false };
  return { dueAt: parsed.toISOString(), allDay: false };
}

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

function resolveProject(name: string | undefined): string | null {
  if (!name) return null;
  const existing = projectsRepo.findByName(name);
  if (existing) return existing.id;
  return projectsRepo.create({ name }).id;
}

function compactTask(task: Task, tz: string): Record<string, unknown> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    due: task.dueAt ? describeDue(task.dueAt, task.allDay, tz) : null,
    dueAt: task.dueAt,
    dueKind: task.dueKind,
    priority: task.priority,
    project: projectName(task.projectId),
    tags: task.tags,
  };
}

function taskLabel(id: string): string {
  const task = tasksRepo.get(id);
  return task ? quote(task.title) : `task ${id}`;
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
      byMonthDay: { type: "integer", description: "Monthly only: day of month", minimum: 1, maximum: 31 },
    },
    required: ["freq"],
  },
};

const PLAN_BLOCK_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    start: { type: "string", description: "Local start time, 24h HH:mm" },
    end: { type: "string", description: "Local end time, 24h HH:mm" },
    label: { type: "string", description: "What happens in this block" },
    taskIds: { type: "array", description: "Real task ids covered by the block", items: { type: "string" } },
    kind: { type: "string", enum: ["focus", "break", "errand", "event"] },
    estimateMin: {
      type: "integer",
      description: "Estimated minutes of actual work in this block (5–240)",
      minimum: 5,
      maximum: 240,
    },
  },
  required: ["start", "end", "label", "kind"],
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
      const due = parseDueInput(args.dueAt, ctx.tz);
      const suffix = due?.dueAt
        ? ` · ${describeDue(due.dueAt, readBoolean(args, "allDay") ?? due.allDay, ctx.tz)}`
        : "";
      return `Added ${quote(title)}${suffix}`;
    },
    async run(args, ctx) {
      const title = readString(args, "title");
      if (!title) return { ok: false, payload: { error: "title is required" } };
      const due = parseDueInput(args.dueAt, ctx.tz);
      const allDay = readBoolean(args, "allDay") ?? due?.allDay ?? false;

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

      const task = tasksRepo.create({
        title,
        notes: readString(args, "notes") ?? "",
        dueAt: due?.dueAt ?? null,
        dueKind: readString(args, "dueKind") === "by" ? "by" : "on",
        allDay,
        priority: readPriority(args) ?? 0,
        projectId: resolveProject(readString(args, "projectName")),
        tags: readTags(args) ?? [],
        recurrence: parseRecurrence(args.recurrence) ?? null,
        location,
      });
      const placeSuffix = location ? ` · 📍 ${location.name}` : "";
      return {
        label: `Added ${quote(task.title)}${task.dueAt ? ` · ${describeDue(task.dueAt, task.allDay, ctx.tz)}` : ""}${placeSuffix}`,
        payload: { created: compactTask(task, ctx.tz), locationNote },
      };
    },
  },

  {
    name: "update_task",
    description:
      "Change fields on an existing task. Only include the fields that change. The id must come from the task list or a previous tool result.",
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
      const patch: Parameters<typeof tasksRepo.update>[1] = {};
      const title = readString(args, "title");
      if (title) patch.title = title;
      const notes = asString(args.notes);
      if (notes !== null) patch.notes = notes;
      const due = parseDueInput(args.dueAt, ctx.tz);
      if (due) {
        patch.dueAt = due.dueAt;
        patch.allDay = readBoolean(args, "allDay") ?? due.allDay;
      } else {
        const allDay = readBoolean(args, "allDay");
        if (allDay !== undefined) patch.allDay = allDay;
      }
      const dueKind = readString(args, "dueKind");
      if (dueKind === "by" || dueKind === "on") patch.dueKind = dueKind;
      const priority = readPriority(args);
      if (priority !== undefined) patch.priority = priority;
      const project = readString(args, "projectName");
      if (project !== undefined) patch.projectId = resolveProject(project);
      const tags = readTags(args);
      if (tags !== undefined) patch.tags = tags;
      const recurrence = parseRecurrence(args.recurrence);
      if (recurrence !== undefined) patch.recurrence = recurrence;

      const task = tasksRepo.update(id, patch);
      if (!task) return { ok: false, payload: { error: "Update failed" } };
      return {
        label: `Updated ${quote(task.title)}`,
        payload: { updated: compactTask(task, ctx.tz) },
      };
    },
  },

  {
    name: "complete_task",
    description: "Mark a task done, or reopen it with done=false.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Existing task id" },
        done: { type: "boolean", description: "Defaults to true" },
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
      const { task, recurred } = tasksRepo.setDone(id, done);
      if (!task) return { ok: false, payload: { error: "No task with that id" } };
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
        tag: { type: "string" },
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
      const project = projectNameArg ? projectsRepo.findByName(projectNameArg) : null;
      if (projectNameArg && !project) {
        return { payload: { count: 0, tasks: [], note: `No project named ${projectNameArg}` } };
      }
      const tasks = tasksRepo.list({
        view,
        q: readString(args, "q"),
        projectId: project?.id,
        tag: readString(args, "tag"),
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
      const existing = projectsRepo.findByName(name);
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
    description: "Add unchecked items to a checklist note, creating the checklist when missing.",
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

  {
    name: "save_day_plan",
    description:
      "Save a time-blocked plan for today. Blocks are 30–90 minutes, must not overlap, and taskIds must be real task ids.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One or two sentences about the shape of the day" },
        blocks: { type: "array", items: PLAN_BLOCK_SCHEMA },
      },
      required: ["summary", "blocks"],
    },
    mutating: true,
    label(args) {
      const n = asArray(args.blocks).length;
      return `Saved today's plan · ${n} block${n === 1 ? "" : "s"}`;
    },
    run(args, ctx) {
      const blocks = normalizePlanBlocks(args.blocks);
      if (blocks.length === 0) return { ok: false, payload: { error: "blocks is empty or malformed" } };
      plansRepo.save({
        dateLocal: ctx.todayKey,
        summary: readString(args, "summary") ?? "",
        blocks,
        accepted: false,
        generatedAt: nowIso(),
      });
      return {
        label: `Saved today's plan · ${blocks.length} block${blocks.length === 1 ? "" : "s"}`,
        payload: { dateLocal: ctx.todayKey, blocks: blocks.length },
      };
    },
  },
];

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
    .filter(Boolean);
}

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function normalizePlanBlocks(raw: unknown): PlanBlock[] {
  const out: PlanBlock[] = [];
  for (const entry of asArray(raw)) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const start = asString(rec.start)?.trim() ?? "";
    const end = asString(rec.end)?.trim() ?? "";
    const label = asString(rec.label)?.trim() ?? "";
    if (!TIME_RE.test(start) || !TIME_RE.test(end) || !label) continue;
    const kindRaw = asString(rec.kind);
    const kind: PlanBlock["kind"] =
      kindRaw === "break" || kindRaw === "errand" || kindRaw === "event" ? kindRaw : "focus";
    const taskIds = asArray(rec.taskIds)
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter(Boolean);
    const estRaw = asNumber(rec.estimateMin ?? rec.estimate);
    const block: PlanBlock = { start: pad(start), end: pad(end), label, taskIds, kind };
    if (estRaw !== null && estRaw > 0) {
      block.estimateMin = Math.round(Math.min(240, Math.max(5, estRaw)));
    }
    out.push(block);
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

function pad(time: string): string {
  const [h, m] = time.split(":");
  return `${h.padStart(2, "0")}:${m}`;
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
  return { tz, todayKey: localDateKey(new Date(), tz), location: location ?? null };
}

/** Falls back to the most recent client-reported position (< 2h old). */
async function lastKnownLocation(): Promise<{ lat: number; lng: number } | null> {
  const last = settingsRepo.getApp().lastLocation;
  if (!last) return null;
  const age = Date.now() - Date.parse(last.at);
  if (!Number.isFinite(age) || age > 2 * 60 * 60 * 1000) return null;
  return { lat: last.lat, lng: last.lng };
}
