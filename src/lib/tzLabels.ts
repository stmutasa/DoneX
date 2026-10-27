/**
 * Due-date wording in the user's timezone, for text written on the server.
 *
 * The helpers in format.ts read the process clock. In a browser that is the
 * user's own; on the server it is UTC, so a 3 PM New York deadline would be
 * written into a digest as "7:00 PM" and an all-day task would turn overdue
 * at 8 PM. These take the zone explicitly. Pure and client-safe.
 */
import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { localDateKey } from "@/lib/utils";

function toDate(value: string | Date): Date {
  return typeof value === "string" ? new Date(value) : value;
}

/** The zone this process runs in: what a caller that passes no tz has always had. */
export function runtimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function dayNumber(key: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/** Calendar days from today to `value`, both read in tz: 0 today, 1 tomorrow, -1 yesterday. */
export function calendarDaysUntil(
  value: string | Date,
  tz: string,
  now: Date = new Date(),
): number {
  return Math.round(dayNumber(localDateKey(value, tz)) - dayNumber(localDateKey(now, tz)));
}

/** "3:00 PM", on the wall clock in tz. */
export function timeIn(value: string | Date, tz: string): string {
  return format(new TZDate(toDate(value), tz), "h:mm a");
}

/**
 * Past due in tz. A timed task is late once its moment has gone; an all-day
 * task only once the day it names has ended there.
 */
export function isOverdueIn(
  dueAt: string | null,
  allDay: boolean,
  tz: string,
  now: Date = new Date(),
): boolean {
  if (!dueAt) return false;
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return false;
  if (allDay) return calendarDaysUntil(d, tz, now) < 0;
  return d.getTime() < now.getTime();
}

/**
 * format.ts's dueLabel, read in tz:
 * "Today 3:00 PM" · "Tomorrow" · "Mon" · "Mon, Aug 12" · "Overdue · 2d"
 */
export function dueLabelIn(
  dueAt: string | null,
  allDay: boolean,
  tz: string,
  now: Date = new Date(),
): string {
  if (!dueAt) return "";
  const d = new Date(dueAt);
  if (Number.isNaN(d.getTime())) return "";
  const dayDiff = calendarDaysUntil(d, tz, now);

  if (isOverdueIn(dueAt, allDay, tz, now)) {
    const behind = -dayDiff;
    if (behind >= 1) return `Overdue · ${behind}d`;
    const hours = Math.floor((now.getTime() - d.getTime()) / 3_600_000);
    if (hours >= 1) return `Overdue · ${hours}h`;
    return "Overdue";
  }

  const zoned = new TZDate(d, tz);
  const time = allDay ? "" : ` ${format(zoned, "h:mm a")}`;
  if (dayDiff === 0) return `Today${time}`;
  if (dayDiff === 1) return `Tomorrow${time}`;
  if (dayDiff > 1 && dayDiff < 7) return `${format(zoned, "EEE")}${time}`;
  const sameYear = format(zoned, "yyyy") === format(new TZDate(now, tz), "yyyy");
  const base = sameYear ? format(zoned, "EEE, MMM d") : format(zoned, "MMM d, yyyy");
  return `${base}${allDay ? "" : ` · ${format(zoned, "h:mm a")}`}`;
}
