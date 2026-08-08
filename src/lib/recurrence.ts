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
          // For interval > 1: count full weeks elapsed since `start`'s week.
          const weeksApart = Math.floor(
            (startOfWeekMs(cursor) - startOfWeekMs(start)) / (7 * 86400_000)
          );
          if (weeksApart % interval === 0) return new Date(cursor.getTime());
        }
        cursor = addDays(cursor, 1);
      }
      return new Date(addDays(start, 7 * interval).getTime());
    }

    case "monthly": {
      let next = addMonths(start, interval);
      const wantDay = rule.byMonthDay ?? getDate(start);
      const maxDay = getDate(lastDayOfMonth(next));
      next = setDate(next, Math.min(wantDay, maxDay));
      return new Date(next.getTime());
    }

    case "yearly":
      return new Date(addYears(start, interval).getTime());
  }
}

function startOfWeekMs(d: Date): number {
  const copy = new Date(d.getTime());
  copy.setHours(0, 0, 0, 0);
  return copy.getTime() - copy.getDay() * 86400_000;
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
    case "monthly":
      return rule.byMonthDay ? `${every("month")} on day ${rule.byMonthDay}` : every("month");
    case "yearly":
      return every("year");
  }
}
