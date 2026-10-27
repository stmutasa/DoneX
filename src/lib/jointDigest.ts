/**
 * The morning digest of the shared list.
 *
 * Each person hears about their own tasks and the ones neither of you has
 * claimed — never about the jobs the other one has taken on. Sundays are off.
 * Pure and client-safe so the rules can be tested without a clock or a model.
 */
import type { SessionRole, Task } from "@/lib/types";
import { dueLabelIn, isOverdueIn, runtimeZone } from "@/lib/tzLabels";

export interface DigestSchedule {
  enabled: boolean;
  /** "HH:mm" local */
  time: string;
}

/** Sunday is the one morning nobody wants a list read at them. */
export const DIGEST_SKIPPED_WEEKDAY = 0;

/** "7:0" and "07:00" mean the same thing; compare them the same way. */
export function normalizeTime(value: string): string {
  const [h = "0", m = "0"] = String(value).split(":");
  const hour = Math.min(23, Math.max(0, parseInt(h, 10) || 0));
  const minute = Math.min(59, Math.max(0, parseInt(m, 10) || 0));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function isValidTime(value: string): boolean {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(value).trim());
}

/**
 * How long after its minute a scheduled send may still go out. A slow or
 * skipped tick, a restart or a DST jump shouldn't cost that day's send; the
 * per-day (or per-week) key is what stops a second one.
 */
export const CATCH_UP_MINUTES = 120;

function minutesOfDay(value: string): number | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
}

/**
 * Is `slot` open on this clock reading: at its minute or inside the catch-up
 * window after it? `minutesIn` is how long ago it opened. A late slot still
 * open past midnight belongs to the evening before (`dayOffset` -1), and that
 * day's date and weekday are the ones to decide and claim on. A time that
 * can't be read never opens.
 */
export function openSlot(
  nowTime: string,
  slot: string,
  windowMinutes: number = CATCH_UP_MINUTES,
): { minutesIn: number; dayOffset: 0 | -1 } | null {
  const now = minutesOfDay(nowTime);
  const at = minutesOfDay(slot);
  if (now === null || at === null) return null;
  if (now >= at) return now - at < windowMinutes ? { minutesIn: now - at, dayOffset: 0 } : null;
  const sinceYesterday = now + 24 * 60 - at;
  return sinceYesterday < windowMinutes ? { minutesIn: sinceYesterday, dayOffset: -1 } : null;
}

/** Is `slot` open on this clock reading? See openSlot. */
export function slotOpen(
  nowTime: string,
  slot: string,
  windowMinutes: number = CATCH_UP_MINUTES,
): boolean {
  return openSlot(nowTime, slot, windowMinutes) !== null;
}

/** 12-hour wording for the UI ("7:00 AM"). */
export function clockLabel(value: string): string {
  const [h, m] = normalizeTime(value).split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

/**
 * Is the send due — its minute, or a late tick inside the catch-up window —
 * on a day we send at all?
 */
export function shouldSendDigest(args: {
  schedule: DigestSchedule;
  /** local "HH:mm" right now */
  nowTime: string;
  /** 0 = Sunday, of the slot's own day (yesterday for a late slot past midnight) */
  weekday: number;
  /** local date key of the slot's own day */
  today: string;
  /** the date key this person was last sent a digest, if any */
  lastSent: string | null;
}): boolean {
  const { schedule, nowTime, weekday, today, lastSent } = args;
  if (!schedule.enabled) return false;
  if (weekday === DIGEST_SKIPPED_WEEKDAY) return false;
  if (!slotOpen(nowTime, schedule.time)) return false;
  return lastSent !== today;
}

/**
 * What this person should hear about: open shared tasks that are theirs or
 * nobody's in particular. Tasks tagged for the other person are their news to
 * get, not yours.
 */
export function tasksForPerson(tasks: Task[], role: SessionRole): Task[] {
  return tasks.filter(
    (t) =>
      t.space === "joint" &&
      t.status !== "done" &&
      !t.parentId &&
      (t.assignedTo === role || t.assignedTo === null),
  );
}

/** Split the way the digest talks about them: yours first, then shared. */
export function splitForDigest(
  tasks: Task[],
  role: SessionRole,
): { mine: Task[]; ours: Task[] } {
  const visible = tasksForPerson(tasks, role);
  return {
    mine: visible.filter((t) => t.assignedTo === role),
    ours: visible.filter((t) => t.assignedTo === null),
  };
}

/**
 * Lines the model reads, and the fallback digest is built from. Due times,
 * "Today"/"Tomorrow" and OVERDUE are all read in the user's tz: the server's
 * own clock is UTC.
 */
export function digestLines(tasks: Task[], tz: string, now: Date = new Date()): string[] {
  return tasks.slice(0, 20).map((t) => {
    const overdue = isOverdueIn(t.dueAt, t.allDay, tz, now);
    const when = t.dueAt ? dueLabelIn(t.dueAt, t.allDay, tz, now) : "";
    const marks = [overdue ? "OVERDUE" : "", when].filter(Boolean).join(" · ");
    return marks ? `- ${t.title} (${marks})` : `- ${t.title}`;
  });
}

/** A usable digest without a model: counts, then the nearest few titles. */
export function fallbackDigest(args: {
  mine: Task[];
  ours: Task[];
  partnerName: string;
  /** their own asks of the other person, now past due */
  waiting?: number;
  /** the user's zone, which decides when an all-day task turns overdue */
  tz?: string;
  now?: Date;
}): string {
  const { mine, ours, partnerName, waiting = 0, tz = runtimeZone(), now = new Date() } = args;
  const overdue = [...mine, ...ours].filter((t) => isOverdueIn(t.dueAt, t.allDay, tz, now)).length;

  const parts: string[] = [];
  if (mine.length) parts.push(`${mine.length} for you`);
  if (ours.length) parts.push(`${ours.length} unclaimed`);
  if (overdue) parts.push(`${overdue} overdue`);

  const head = parts.length ? parts.join(" · ") : "Nothing on the shared list";
  const titles = [...mine, ...ours].slice(0, 3).map((t) => t.title);
  const body = titles.length ? `${head}: ${titles.join(", ")}` : head;
  return waiting > 0 ? `${body}. Still waiting on ${partnerName} for ${waiting}.` : body;
}
