/**
 * TaskEditor's form logic, kept free of React so it can be tested on its own:
 * reading a task into editable fields, turning the fields back into a draft,
 * and working out which fields an edit actually changed.
 */
import { format } from "date-fns";
import type {
  Priority,
  RecurrenceRule,
  SessionRole,
  Task,
  TaskDraft,
  TaskLocation,
  TaskPatch,
} from "@/lib/types";
import { allDayKey, toDateInput } from "@/lib/format";
import { addDaysToDateKey, isoFromLocal, localDateKey } from "@/lib/utils";

export interface FormState {
  title: string;
  notes: string;
  dueDate: string;
  dueTime: string;
  dueKind: "on" | "by";
  /** The All-day switch. A date with no time is all-day either way. */
  allDay: boolean;
  priority: Priority;
  projectId: string;
  tags: string[];
  recurrence: RecurrenceRule | null;
  location: TaskLocation | null;
  assignedTo: "" | SessionRole;
  /** dueDate was filled in from the repeat rule rather than picked */
  dateFromRepeat: boolean;
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * "YYYY-MM-DD" for today in `tz`, or on this device without one. Date-only
 * picks are stored as all-day days in the app's zone, so they count from
 * today there.
 */
export function todayKey(tz?: string, now: Date = new Date()): string {
  if (tz) {
    try {
      return localDateKey(now, tz);
    } catch {
      /* unknown zone: fall back to the device's day */
    }
  }
  return format(now, "yyyy-MM-dd");
}

/**
 * The day an all-day due names. format.allDayKey is the one reader, so the
 * editor, the row and the Upcoming groups always agree on it.
 */
function allDayDate(iso: string): string {
  return Number.isNaN(new Date(iso).getTime()) ? "" : allDayKey(iso);
}

function allDayIso(dateKey: string, tz: string): string | null {
  try {
    return isoFromLocal(dateKey, "00:00", tz);
  } catch {
    const d = new Date(`${dateKey}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
}

function timeInput(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : format(d, "HH:mm");
}

/** All-day dates are read in the display zone (format.setDisplayTimeZone). */
export function stateFrom(
  task: Task | null | undefined,
  initial: Partial<TaskDraft> | undefined,
): FormState {
  const src = task ?? initial;
  const dueAt = src?.dueAt ?? null;
  const allDay = src?.allDay ?? false;
  return {
    assignedTo: src?.assignedTo ?? "",
    title: src?.title ?? "",
    notes: src?.notes ?? "",
    // Timed dues are instants and show in device time, like everywhere else.
    dueDate: dueAt ? (allDay ? allDayDate(dueAt) : toDateInput(dueAt)) : "",
    dueTime: dueAt && !allDay ? timeInput(dueAt) : "",
    dueKind: src?.dueKind === "by" ? "by" : "on",
    allDay,
    priority: (src?.priority ?? 0) as Priority,
    projectId: src?.projectId ?? "",
    tags: src?.tags ?? [],
    recurrence: src?.recurrence ?? null,
    location: src?.location ?? null,
    dateFromRepeat: false,
  };
}

/** A date without a time is all-day, the same as quick-add treats it. */
export function isAllDay(s: FormState): boolean {
  return !!s.dueDate && (s.allDay || !s.dueTime);
}

export function composeDue(s: FormState, tz: string): string | null {
  if (!DATE_KEY_RE.test(s.dueDate)) return null;
  if (isAllDay(s)) return allDayIso(s.dueDate, tz);
  const d = new Date(`${s.dueDate}T${s.dueTime}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function buildDraft(s: FormState, tz: string): TaskDraft {
  const dueAt = composeDue(s, tz);
  return {
    title: s.title.trim(),
    notes: s.notes,
    priority: s.priority,
    dueAt,
    dueKind: dueAt ? s.dueKind : "on",
    allDay: dueAt !== null && isAllDay(s),
    projectId: s.projectId || null,
    tags: s.tags,
    recurrence: s.recurrence,
    location: s.location,
    assignedTo: s.assignedTo || null,
  };
}

/**
 * Only the fields that differ between two drafts. Resending an unchanged
 * dueAt would clear the reminder flag and re-encode the date, so an edit
 * sends just what the user touched.
 */
export function changedFields(before: TaskDraft, after: TaskDraft): TaskPatch {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(after) as (keyof TaskDraft)[]) {
    if (JSON.stringify(after[key] ?? null) !== JSON.stringify(before[key] ?? null)) {
      patch[key] = after[key];
    }
  }
  // The due moment and its all-day flag only make sense together.
  if ("dueAt" in patch || "allDay" in patch) {
    patch.dueAt = after.dueAt ?? null;
    patch.allDay = after.allDay ?? false;
  }
  return patch as TaskPatch;
}

function parseKey(key: string): [number, number, number] {
  const [y, m, d] = key.split("-").map(Number);
  return [y, m, d];
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function keyOf(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** The first day on or after `today` ("YYYY-MM-DD") that a repeat rule lands on. */
export function firstOccurrenceKey(rule: RecurrenceRule, today: string): string {
  if (rule.freq === "weekly") {
    const days = (rule.byWeekday ?? []).filter((d) => d >= 0 && d <= 6);
    if (!days.length) return today;
    for (let i = 0; i < 7; i++) {
      const key = addDaysToDateKey(today, i);
      const [y, m, d] = parseKey(key);
      if (days.includes(new Date(Date.UTC(y, m - 1, d)).getUTCDay())) return key;
    }
    return today;
  }
  if (rule.freq === "monthly" && rule.byMonthDay) {
    const [y, m, d] = parseKey(today);
    const want = rule.byMonthDay;
    const thisMonth = Math.min(want, daysInMonth(y, m));
    if (thisMonth >= d) return keyOf(y, m, thisMonth);
    const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
    return keyOf(ny, nm, Math.min(want, daysInMonth(ny, nm)));
  }
  return today;
}

/**
 * A visible time for a date that had none: 09:00, or the next hour once 09:00
 * has passed today. A typed time is composed in device time (composeDue), so
 * whether 09:00 has passed is judged by the device's day and clock too.
 */
export function defaultTime(dateKey: string, now: Date = new Date()): string {
  const hour = now.getHours();
  if (dateKey !== todayKey(undefined, now) || hour < 9) return "09:00";
  return hour >= 23 ? "23:59" : `${String(hour + 1).padStart(2, "0")}:00`;
}
