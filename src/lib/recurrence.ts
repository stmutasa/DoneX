import { TZDate } from "@date-fns/tz";
import { addDays, addMonths, addYears, getDate, lastDayOfMonth, setDate } from "date-fns";
import type { RecurrenceRule } from "@/lib/types";

/**
 * Compute the next occurrence after `from`, evaluated as wall-clock time in
 * `tz` so schedules stay stable across DST transitions. Time-of-day is
 * preserved from `from`.
 */
export function nextOccurrence(rule: RecurrenceRule, from: Date, tz: string): Date {
  const interval = Math.max(1, Math.round(rule.interval ?? 1));
  const start = new TZDate(from, tz);

  switch (rule.freq) {
    case "daily":
      return new Date(addDays(start, interval).getTime());

    case "weekly": {
      const days = (rule.byWeekday ?? []).filter((d) => d >= 0 && d <= 6);
      if (days.length === 0) {
        return new Date(addDays(start, 7 * interval).getTime());
      }
      // Walk forward day by day. When crossing into a new week-cycle, skip
      // ahead by the interval. Capped walk keeps this trivially safe.
      let cursor = addDays(start, 1);
      for (let i = 0; i < 800; i++) {
        if (days.includes(cursor.getDay())) {
          if (interval === 1) return new Date(cursor.getTime());
          // For interval > 1: count full weeks elapsed since `start`'s week,
          // with weeks starting on Sunday in `tz`.
          const weeksApart = Math.round((weekStartDay(cursor) - weekStartDay(start)) / 7);
          if (weeksApart % interval === 0) return new Date(cursor.getTime());
        }
        cursor = addDays(cursor, 1);
      }
      return new Date(addDays(start, 7 * interval).getTime());
    }

    case "monthly":
      return new Date(onDay(addMonths(start, interval), rule.byMonthDay ?? getDate(start)).getTime());

    case "yearly":
      return new Date(onDay(addYears(start, interval), yearlyDay(rule, start)).getTime());
  }
}

/**
 * Pin the anchor day of a monthly or yearly rule from the occurrence at
 * `from`, so clamping to a short month (Jan 31 → Feb 28) never feeds back
 * into later repeats. Callers store the result with the task. Returns the
 * same rule when there is nothing to pin.
 */
export function anchorRule(rule: RecurrenceRule, from: Date, tz: string): RecurrenceRule {
  const start = new TZDate(from, tz);
  if (rule.freq === "monthly") {
    return rule.byMonthDay ? rule : { ...rule, byMonthDay: getDate(start) };
  }
  if (rule.freq === "yearly") {
    const day = yearlyDay(rule, start);
    return day === rule.byMonthDay ? rule : { ...rule, byMonthDay: day };
  }
  return rule;
}

/** The anchor day in `next`'s month, clamped to the month's length. */
function onDay(next: TZDate, wantDay: number): TZDate {
  return setDate(next, Math.min(wantDay, getDate(lastDayOfMonth(next))));
}

/**
 * Yearly rules keep their stored day only while `start` still sits on it, or
 * on Feb 28 for a Feb 29 rule in a common year (the one clamp a yearly rule
 * can hit). The editor never shows that day, so once the date is moved by
 * hand the new day wins.
 */
function yearlyDay(rule: RecurrenceRule, start: TZDate): number {
  const day = getDate(start);
  const want = rule.byMonthDay;
  if (want === day) return want;
  if (want === 29 && start.getMonth() === 1 && day === getDate(lastDayOfMonth(start))) return want;
  return day;
}

/**
 * Day number of the Sunday that starts `d`'s week, read in `d`'s own zone.
 * Calendar fields only, so DST and the server's zone never shift the count.
 */
function weekStartDay(d: TZDate): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400_000 - d.getDay();
}

export function describeRecurrence(rule: RecurrenceRule | null): string {
  if (!rule) return "";
  const n = Math.max(1, Math.round(rule.interval ?? 1));
  const every = (unit: string) => (n === 1 ? `Every ${unit}` : `Every ${n} ${unit}s`);
  switch (rule.freq) {
    case "daily":
      return every("day");
    case "weekly": {
      const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const days = (rule.byWeekday ?? []).map((d) => names[d]).join(", ");
      return days ? `${every("week")} on ${days}` : every("week");
    }
    case "monthly": {
      // Three months is a quarter, and people say quarterly.
      const base = n === 3 ? "Quarterly" : every("month");
      return rule.byMonthDay ? `${base} on day ${rule.byMonthDay}` : base;
    }
    case "yearly":
      return every("year");
  }
}
