/**
 * Deadline ("do X by <date>") helpers.
 *
 * A task with dueKind "by" is doable any day up to its date: it surfaces on
 * Today every day until the deadline, and its priority escalates as the date
 * approaches. Client-safe — no Node imports.
 */
import type { Priority, Task } from "@/lib/types";
import { localDateKey } from "@/lib/utils";

function dateKeyToUTC(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Whole days between two YYYY-MM-DD keys (to − from). */
export function diffDayKeys(fromKey: string, toKey: string): number {
  return Math.round((dateKeyToUTC(toKey) - dateKeyToUTC(fromKey)) / 86_400_000);
}

/** Whole local days from now until dueAt. 0 = due today, negative = past. */
export function daysUntil(dueAt: string, tz: string, now: Date = new Date()): number {
  return diffDayKeys(localDateKey(now, tz), localDateKey(dueAt, tz));
}

/**
 * Priority after deadline escalation. "by" tasks climb as the date nears —
 * ≤1 day out → high, ≤2 → at least medium, ≤4 → at least low. "on" tasks
 * (and undated tasks) keep whatever priority was set.
 */
export function effectivePriority(
  task: Pick<Task, "priority" | "dueAt" | "dueKind">,
  tz: string,
  now: Date = new Date(),
): Priority {
  if (!task.dueAt || task.dueKind !== "by") return task.priority;
  const d = daysUntil(task.dueAt, tz, now);
  if (d <= 1) return 3;
  if (d <= 2) return Math.max(task.priority, 2) as Priority;
  if (d <= 4) return Math.max(task.priority, 1) as Priority;
  return task.priority;
}

/**
 * Is this task close enough to matter today? Overdue, due today, or a deadline
 * landing by tomorrow. Project tasks use this to break through onto Today;
 * everything else in a project waits on the Projects tab.
 */
export function isUrgent(
  task: Pick<Task, "dueAt">,
  tz: string,
  now: Date = new Date(),
): boolean {
  return !!task.dueAt && daysUntil(task.dueAt, tz, now) <= 1;
}

/** True when escalation is currently holding this task above its set priority. */
export function isEscalated(
  task: Pick<Task, "priority" | "dueAt" | "dueKind">,
  tz: string,
  now: Date = new Date(),
): boolean {
  return effectivePriority(task, tz, now) > task.priority;
}

/** Chip label for a deadline task, e.g. "by Fri · 3d left". */
export function deadlineLabel(dueAt: string, tz: string, now: Date = new Date()): string {
  const d = daysUntil(dueAt, tz, now);
  if (d < 0) return d === -1 ? "by yesterday · overdue" : `overdue ${-d}d`;
  if (d === 0) return "by today";
  if (d === 1) return "by tomorrow";
  const due = new Date(dueAt);
  const day =
    d < 7
      ? new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(due)
      : new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(
          due,
        );
  return `by ${day} · ${d}d left`;
}
