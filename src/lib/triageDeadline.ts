/**
 * Every task the inbox turns into gets a deadline and a priority.
 *
 * The model is asked to work out a sensible one when the message doesn't
 * state it; this is what stands behind that request, so a vague or malformed
 * answer still ends with something real on the task. It also keeps the line
 * between a date the sender actually gave and one that was worked out — a
 * guess must never be presented as if someone had said it.
 *
 * Pure and tz-free: everything here is local date keys ("YYYY-MM-DD").
 */
import { addDaysToDateKey } from "@/lib/utils";

/** How far out a task lands when nothing better can be worked out. */
export const DEFAULT_HORIZON_DAYS = 7;
/** An inferred deadline further out than this has stopped being a deadline. */
export const MAX_INFERRED_DAYS = 30;

export type DeadlineBasis = "stated" | "inferred";

export interface SettledDeadline {
  /** "YYYY-MM-DD HH:mm" for a stated moment, otherwise a whole day */
  dueAtLocal: string;
  dueKind: "on" | "by";
  /** true when no one actually named this date */
  inferred: boolean;
  /** why that date, for an inferred one; "" for a stated one */
  why: string;
}

// What may sit between the date and its time: "T", or a space with an
// optional "at" / "by" / "before" / "until" / "@".
const TIME_LEAD = String.raw`^(?:\s*T\s*|,?\s+(?:(?:at|by|before|until)\s+|@\s*)?)`;
// "5", "5:00", "17:00:00", "07:05:00.000" …
const CLOCK_RE = new RegExp(String.raw`${TIME_LEAD}(\d{1,2})(?::(\d{2}))?(?::\d{2}(?:\.\d+)?)?`, "iu");
// … then perhaps "pm", "a.m.", "in the afternoon".
const MERIDIEM_RE = /^\s*(?:([ap])\.?\s*m\.?(?!\p{L})|in\s+the\s+(morning|afternoon|evening)(?!\p{L}))/iu;
const NOON_RE = new RegExp(String.raw`${TIME_LEAD}noon(?!\p{L})`, "iu");

/**
 * A local due value as exactly "YYYY-MM-DD HH:mm" or "YYYY-MM-DD", or null
 * when it does not start with a real date. Besides the asked-for shape it
 * reads the ones a model drifts into ("2026-10-30T17:00", "2026-10-30 5:00 PM",
 * "2026-10-30 5pm"), and keeps just the date when what follows is not a time
 * ("2026-10-30 EOD", "2026-10-30 (Fri)"), so the result always parses.
 */
export function normalizeLocalDue(raw: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})([\s\S]*)$/.exec(raw.trim());
  if (!m || !validKey(m[1])) return null;
  const time = readTime(m[2]);
  return time ? `${m[1]} ${time}` : m[1];
}

function readTime(rest: string): string | null {
  if (NOON_RE.test(rest)) return "12:00";
  const clock = CLOCK_RE.exec(rest);
  if (!clock) return null;
  const after = rest.slice(clock[0].length);
  if (/^\d/.test(after)) return null;
  let hour = Number(clock[1]);
  const minute = clock[2] ? Number(clock[2]) : 0;
  const meridiem = MERIDIEM_RE.exec(after);
  if (meridiem) {
    const pm = meridiem[1]
      ? meridiem[1].toLowerCase() === "p"
      : meridiem[2].toLowerCase() !== "morning";
    if (hour >= 1 && hour <= 12) hour = (hour % 12) + (pm ? 12 : 0);
    else if (!(pm && hour <= 23)) return null; // "17:00 PM" is still 17:00
  } else if (!clock[2]) {
    return null; // a bare number is not a time
  }
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** The model's word on where the date came from; anything unclear counts as a guess. */
export function readBasis(raw: unknown): DeadlineBasis {
  return typeof raw === "string" && raw.trim().toLowerCase() === "stated" ? "stated" : "inferred";
}

/**
 * Turn whatever the model offered into the deadline the task will carry.
 *
 * A stated date is kept exactly — even one already past, which is the truth
 * and shows as overdue. An inferred one becomes a whole-day "by" target,
 * pulled forward from the past and back from the far future; and when there
 * is nothing usable at all, the task still gets a week.
 */
export function settleDeadline(input: {
  dueAtLocal: string | null;
  basis: DeadlineBasis;
  why: string;
  dueKind: "on" | "by";
  todayKey: string;
}): SettledDeadline {
  const local = normalizeLocalDue(input.dueAtLocal ?? "");
  const why = input.why.trim().replace(/\s+/g, " ").slice(0, 100);

  if (!local) {
    return {
      dueAtLocal: addDaysToDateKey(input.todayKey, DEFAULT_HORIZON_DAYS),
      dueKind: "by",
      inferred: true,
      why: "a week, by default",
    };
  }

  if (input.basis === "stated") {
    return { dueAtLocal: local, dueKind: input.dueKind, inferred: false, why: "" };
  }

  // A guessed time of day is false precision, and a guessed date is a target
  // to finish by rather than a moment something happens.
  const latest = addDaysToDateKey(input.todayKey, MAX_INFERRED_DAYS);
  let key = local.slice(0, 10);
  if (key < input.todayKey) key = input.todayKey;
  if (key > latest) key = latest;
  return {
    dueAtLocal: key,
    dueKind: "by",
    inferred: true,
    why: why || "worked out from what was asked",
  };
}

/** Every task gets a real priority: 1 (minor) to 3 (urgent), never "none". */
export function settlePriority(raw: unknown): 1 | 2 | 3 {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return 1;
  return Math.min(3, Math.max(1, Math.round(n))) as 1 | 2 | 3;
}

function validKey(key: string): boolean {
  const [y, m, d] = key.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}
