/**
 * The Sunday look at the week to come, for the two of you.
 *
 * It follows the same rule as the morning digest — you hear about your own
 * tasks and the unclaimed ones, not about the jobs the other person has taken
 * on — but adds the shared calendar, which is a surface you already both see,
 * and a bare count of their load so you know roughly where they stand without
 * being handed their list. Pure and client-safe.
 */
import type { CalendarEvent, SessionRole, Task } from "@/lib/types";
import { slotOpen } from "@/lib/jointDigest";
import { isOverdueIn, runtimeZone, timeIn } from "@/lib/tzLabels";
import { isoFromLocal, localDateKey } from "@/lib/utils";

export interface WeekAheadContext {
  /** tagged for the person being written to */
  mine: Task[];
  /** on the shared list, claimed by neither */
  ours: Task[];
  /** how much the other person is carrying — a number, never their titles */
  theirCount: number;
  /** anything already late, out of the two lists above */
  overdueCount: number;
  /** both calendars for the week, in time order */
  events: CalendarEvent[];
  /** the user's zone, which the dates in contextLines are written in */
  tz?: string;
}

/** Open joint tasks that concern this person, plus the other's workload. */
export function weekAheadContext(args: {
  tasks: Task[];
  events: CalendarEvent[];
  role: SessionRole;
  /** settings.tz: the server's own clock is UTC */
  tz?: string;
  now?: Date;
}): WeekAheadContext {
  const { tasks, events, role, tz = runtimeZone(), now = new Date() } = args;
  const other: SessionRole = role === "owner" ? "partner" : "owner";

  // In time order by instant: timed starts are UTC or offset strings, and an
  // all-day date starts at local midnight — compared as text, a Friday 9 PM
  // dinner would sort after Saturday's all-day event.
  const startOf = (e: CalendarEvent): number => {
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(e.start) ? isoFromLocal(e.start, "00:00", tz) : e.start;
    const at = Date.parse(iso);
    return Number.isNaN(at) ? Number.MAX_SAFE_INTEGER : at;
  };

  const open = tasks.filter((t) => t.space === "joint" && t.status !== "done" && !t.parentId);
  const mine = open.filter((t) => t.assignedTo === role);
  const ours = open.filter((t) => t.assignedTo === null);

  return {
    mine,
    ours,
    theirCount: open.filter((t) => t.assignedTo === other).length,
    overdueCount: [...mine, ...ours].filter((t) => isOverdueIn(t.dueAt, t.allDay, tz, now)).length,
    events: [...events].sort((a, b) => startOf(a) - startOf(b)),
    tz,
  };
}

/**
 * Lines for the model: titles only, no ids, nothing of the other person's.
 * Dates are the user's local ones — stored instants are UTC, and an evening
 * deadline sliced as UTC lands on the next day.
 */
export function contextLines(
  ctx: WeekAheadContext,
  tz: string = ctx.tz ?? runtimeZone(),
): { mine: string; ours: string; events: string } {
  const local = (iso: string): string => `${localDateKey(iso, tz)} at ${timeIn(iso, tz)}`;
  const taskDay = (t: Task): string => {
    const due = t.dueAt as string;
    if (Number.isNaN(Date.parse(due))) return due.slice(0, 10);
    // All-day due dates are stored as local midnight in tz, so tz names the day.
    return t.allDay ? localDateKey(due, tz) : local(due);
  };
  // An all-day event's start is a bare date (or that date's midnight), not
  // an instant in anyone's zone, so it is taken as written.
  const eventDay = (e: CalendarEvent): string =>
    e.allDay || Number.isNaN(Date.parse(e.start)) ? e.start.slice(0, 10) : local(e.start);
  const task = (t: Task) => `- ${t.title}${t.dueAt ? ` (due ${taskDay(t)})` : ""}`;
  const event = (e: CalendarEvent) =>
    `- ${e.title}${e.allDay ? " (all day)" : ""} on ${eventDay(e)}`;
  return {
    mine: ctx.mine.slice(0, 20).map(task).join("\n"),
    ours: ctx.ours.slice(0, 20).map(task).join("\n"),
    events: ctx.events.slice(0, 25).map(event).join("\n"),
  };
}

/** A usable summary with no model involved. */
export function fallbackWeekAhead(ctx: WeekAheadContext, partnerName: string): string {
  const bits: string[] = [];
  if (ctx.mine.length) bits.push(`${ctx.mine.length} tagged for you`);
  if (ctx.ours.length) bits.push(`${ctx.ours.length} unclaimed`);
  if (ctx.overdueCount) bits.push(`${ctx.overdueCount} already late`);
  if (ctx.theirCount) bits.push(`${partnerName} has ${ctx.theirCount}`);
  if (ctx.events.length) bits.push(`${ctx.events.length} things on the calendar`);

  if (bits.length === 0) return "A clear week on the shared list — nothing booked, nothing pending.";

  const head = `Week ahead: ${bits.join(" · ")}.`;
  const first = ctx.mine[0] ?? ctx.ours[0];
  return first ? `${head} Starting with “${first.title}”.` : head;
}

// ── The last one sent ──────────────────────────────────────────────────────

/** The last one each person was sent, so it survives a dismissed banner. */
export interface LastWeekAhead {
  text: string;
  /** the Monday the summary looked ahead from */
  weekOf: string;
  at: string;
}

/** The settings key it is kept under, per person. */
export const kvLastWeekAhead = (role: SessionRole) => `joint.weekAhead.${role}`;

/** What that key holds, or null when there is nothing usable. */
export function parseLastWeekAhead(raw: string | null): LastWeekAhead | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LastWeekAhead>;
    if (typeof parsed.text !== "string" || !parsed.text) return null;
    return { text: parsed.text, weekOf: parsed.weekOf ?? "", at: parsed.at ?? "" };
  } catch {
    return null;
  }
}

/** Is there enough here to be worth a Sunday evening notification? */
export function worthSending(ctx: WeekAheadContext): boolean {
  return ctx.mine.length + ctx.ours.length + ctx.events.length > 0;
}

// ── When it goes out ───────────────────────────────────────────────────────

/** Sunday. The whole point is landing the evening before the week starts. */
export const WEEK_AHEAD_WEEKDAY = 0;

export interface WeekAheadSchedule {
  enabled: boolean;
  time: string; // "18:00" local
}

/**
 * Sunday evening, at your own hour (or a late tick inside the catch-up
 * window), once per week. The week key — not the date — is what stops a
 * repeat, so a clock that slips an hour on a trip can't buy a second copy.
 */
export function shouldSendWeekAhead(args: {
  schedule: WeekAheadSchedule;
  nowTime: string;
  /** weekday and week key of the slot's own day (yesterday for a late slot past midnight) */
  weekday: number;
  weekKey: string;
  lastSent: string | null;
}): boolean {
  const { schedule, nowTime, weekday, weekKey, lastSent } = args;
  if (!schedule.enabled) return false;
  if (weekday !== WEEK_AHEAD_WEEKDAY) return false;
  if (lastSent === weekKey) return false;
  return slotOpen(nowTime, normalizeWeekTime(schedule.time));
}

/** "7:0" → "07:00"; anything unreadable falls back to the evening default. */
export function normalizeWeekTime(time: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec((time ?? "").trim());
  if (!m) return "18:00";
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return "18:00";
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * The seven days being summarised: the Monday after the Sunday it is sent,
 * through the Sunday after that. Date-key arithmetic only, so it is the same
 * answer in any timezone.
 */
export function weekWindow(todayKey: string): { fromKey: string; toKey: string } {
  const fromKey = shiftKey(todayKey, 1);
  return { fromKey, toKey: shiftKey(fromKey, 7) };
}

function shiftKey(dateLocal: string, days: number): string {
  const [y, m, d] = dateLocal.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}
