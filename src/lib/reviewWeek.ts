/**
 * Which week a weekly review is about, and when a saved one still stands.
 * Date-key arithmetic only, so the answers are the same in any timezone.
 * Pure and client-safe.
 */
import { addDaysToDateKey, isoWeekKey, localDateKey } from "@/lib/utils";

/** ISO week key ("2026-W44") of a local "YYYY-MM-DD" date key. */
export function weekKeyOfDay(dateKey: string): string {
  return isoWeekKey(new Date(`${dateKey}T12:00:00Z`), "UTC");
}

function weekdayOf(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The Monday-to-Sunday week a review sent on `dateKey` covers: the one that
 * ends that day when it is a Sunday, otherwise the last one to have finished.
 * A Monday review is about the week just gone, not the one that began that
 * morning.
 */
export function reviewedWeek(dateKey: string): { weekKey: string; from: string; to: string } {
  const sunday = addDaysToDateKey(dateKey, -weekdayOf(dateKey));
  return { weekKey: weekKeyOfDay(sunday), from: addDaysToDateKey(sunday, -6), to: sunday };
}

/** Monday and Sunday date keys of an ISO week key, or null for anything else. */
export function weekRange(weekKey: string): { from: string; to: string } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey);
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = Date.UTC(year, 0, 4);
  const isoDow = (new Date(jan4).getUTCDay() + 6) % 7; // Monday = 0
  const monday = jan4 - isoDow * 86_400_000 + (week - 1) * 7 * 86_400_000;
  const key = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: key(monday), to: key(monday + 6 * 86_400_000) };
}

/** The Sunday that ends an ISO week key, or null for anything else. */
export function weekEndKey(weekKey: string): string | null {
  return weekRange(weekKey)?.to ?? null;
}

/**
 * Should a saved review be written again before it is shown? Each rewrite is
 * a paid model call, so only when it has fallen behind:
 * - one made on or after the week's last day is that week's review for good;
 * - one made before a finished week ended is redone (once — after that it
 *   was made after the end);
 * - one made on an earlier day of a week still under way is redone only if
 *   the completions it counts have changed since.
 */
export function reviewIsStale(args: {
  generatedAt: string;
  /** what the saved review counted */
  completedCount: number;
  weekKey: string;
  todayKey: string;
  tz: string;
  /** completions in the week's range right now; only asked for a week under way */
  completedNow: () => number;
}): boolean {
  const { generatedAt, completedCount, weekKey, todayKey, tz, completedNow } = args;
  const end = weekEndKey(weekKey);
  if (!end || Number.isNaN(Date.parse(generatedAt))) return false;
  const made = localDateKey(generatedAt, tz);
  if (made >= end) return false;
  if (todayKey > end) return true;
  return made < todayKey && completedNow() !== completedCount;
}
