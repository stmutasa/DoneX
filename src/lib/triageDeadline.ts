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
  const raw = (input.dueAtLocal ?? "").trim();
  const dateKey = /^(\d{4}-\d{2}-\d{2})/.exec(raw)?.[1] ?? null;
  const why = input.why.trim().replace(/\s+/g, " ").slice(0, 100);

  if (!dateKey || !validKey(dateKey)) {
    return {
      dueAtLocal: addDaysToDateKey(input.todayKey, DEFAULT_HORIZON_DAYS),
      dueKind: "by",
      inferred: true,
      why: "a week, by default",
    };
  }

  if (input.basis === "stated") {
    return { dueAtLocal: raw, dueKind: input.dueKind, inferred: false, why: "" };
  }

  // A guessed time of day is false precision, and a guessed date is a target
  // to finish by rather than a moment something happens.
  const latest = addDaysToDateKey(input.todayKey, MAX_INFERRED_DAYS);
  let key = dateKey;
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
