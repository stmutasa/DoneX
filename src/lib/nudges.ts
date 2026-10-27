/**
 * Nudges on delegated work that has gone past due.
 *
 * When one of you tags a shared task for the other and the deadline passes,
 * the person it was tagged for hears about it once — gently, and once per
 * deadline, so moving the due date is what earns a second word rather than
 * another day going by. The person who asked doesn't get a buzz at all; they
 * see it as "still waiting on" in their own morning digest, which is the
 * quiet half of this and the reason the loud half can stay quiet.
 *
 * Pure and client-safe.
 */
import type { SessionRole, Task } from "@/lib/types";
import { calendarDaysUntil, runtimeZone } from "@/lib/tzLabels";

/** At most this many named in one nudge; the rest become "and N more". */
const NAMED = 2;
/** Nothing older than this is worth raising again — it isn't a deadline any more. */
export const STALE_AFTER_DAYS = 30;

export interface NudgeItem {
  id: string;
  title: string;
  dueAt: string;
  /** who it was tagged for */
  assignedTo: SessionRole;
  /** who did the tagging */
  createdBy: SessionRole;
  daysLate: number;
}

/**
 * Past its moment — for an all-day task, past the end of that day in `tz`.
 * The server runs in UTC, so the zone has to be the user's, not the
 * process's; without one, the process's zone is used.
 */
export function pastDue(task: Task, now: Date, tz: string = runtimeZone()): boolean {
  if (!task.dueAt) return false;
  const due = new Date(task.dueAt);
  if (Number.isNaN(due.getTime())) return false;
  if (task.allDay) {
    // An all-day task is late once the calendar day it names has ended.
    return calendarDaysUntil(due, tz, now) < 0;
  }
  return due.getTime() < now.getTime();
}

/**
 * Calendar days, in `tz`, from the deadline's day to today; 0 means it was
 * due earlier today, 1 yesterday. Never negative.
 */
export function daysLate(dueAt: string, now: Date, tz: string = runtimeZone()): number {
  if (Number.isNaN(new Date(dueAt).getTime())) return 0;
  return Math.max(0, -calendarDaysUntil(dueAt, tz, now));
}

/** Genuinely handed to someone else — tagging yourself is just a note. */
function delegated(task: Task): boolean {
  return (
    task.space === "joint" &&
    task.status !== "done" &&
    !task.parentId &&
    task.assignedTo !== null &&
    task.assignedTo !== task.createdBy
  );
}

function toItem(task: Task, now: Date, tz: string): NudgeItem {
  return {
    id: task.id,
    title: task.title,
    dueAt: task.dueAt as string,
    assignedTo: task.assignedTo as SessionRole,
    createdBy: task.createdBy,
    daysLate: daysLate(task.dueAt as string, now, tz),
  };
}

/**
 * What to nudge `role` about: work the other person asked of them, now past
 * due, not yet raised for this particular deadline, and not so old that it
 * has stopped being a deadline at all.
 */
export function nudgesFor(args: {
  tasks: Task[];
  role: SessionRole;
  now: Date;
  /** the deadline each task was last nudged about, by task id */
  nudgedDueAt: (id: string) => string | null;
  /** the user's zone (settings.tz), which decides when a day has ended */
  tz?: string;
}): NudgeItem[] {
  const { tasks, role, now, nudgedDueAt, tz = runtimeZone() } = args;
  return tasks
    .filter(
      (t) =>
        delegated(t) &&
        t.assignedTo === role &&
        pastDue(t, now, tz) &&
        nudgedDueAt(t.id) !== t.dueAt,
    )
    .map((t) => toItem(t, now, tz))
    .filter((i) => i.daysLate <= STALE_AFTER_DAYS)
    .sort((a, b) => b.daysLate - a.daysLate);
}

/**
 * What `role` is still waiting on: their own asks, gone past due.
 *
 * Held to the same staleness cap as the nudge, so the two halves always agree
 * — everything listed here is something the other person has actually been
 * told about once, which is what makes it fair to mention.
 */
export function waitingOn(
  tasks: Task[],
  role: SessionRole,
  now: Date,
  tz: string = runtimeZone(),
): NudgeItem[] {
  return tasks
    .filter((t) => delegated(t) && t.createdBy === role && pastDue(t, now, tz))
    .map((t) => toItem(t, now, tz))
    .filter((i) => i.daysLate <= STALE_AFTER_DAYS)
    .sort((a, b) => b.daysLate - a.daysLate);
}

/** "yesterday" · "3 days ago" · "earlier today" */
export function latenessLabel(days: number): string {
  if (days <= 0) return "earlier today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** The notification itself — one per person, however many things are late. */
export function nudgeText(items: NudgeItem[], askerName: string): { title: string; body: string } {
  const [first, ...rest] = items;
  if (!first) return { title: "", body: "" };

  if (rest.length === 0) {
    return {
      title: `Still open: ${first.title}`,
      body: `${askerName} asked you about this — it was due ${latenessLabel(first.daysLate)}. No rush if it's moved on.`,
    };
  }

  const named = items.slice(0, NAMED).map((i) => `“${i.title}”`);
  const more = items.length - named.length;
  const list = more > 0 ? `${named.join(", ")} and ${more} more` : named.join(" and ");
  return {
    title: `${items.length} things ${askerName} asked about`,
    body: `${list} — all past due. Tap to sort them out or push the dates.`,
  };
}

/** The line the asker sees in their own digest, instead of a notification. */
export function waitingLines(items: NudgeItem[], partnerName: string): string {
  if (items.length === 0) return "";
  return items
    .slice(0, 5)
    .map((i) => `- ${i.title} — asked of ${partnerName}, due ${latenessLabel(i.daysLate)}`)
    .join("\n");
}
