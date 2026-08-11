import { clsx, type ClassValue } from "clsx";
import { TZDate } from "@date-fns/tz";
import { format, getISOWeek, getISOWeekYear } from "date-fns";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** "YYYY-MM-DD" for a moment, in the given IANA timezone */
export function localDateKey(date: Date | string, tz: string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return format(new TZDate(d, tz), "yyyy-MM-dd");
}

/** "HH:mm" local wall time in tz */
export function localTimeKey(date: Date | string, tz: string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return format(new TZDate(d, tz), "HH:mm");
}

/** ISO week key "2026-W32" in tz */
export function isoWeekKey(date: Date | string, tz: string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const t = new TZDate(d, tz);
  return `${getISOWeekYear(t)}-W${String(getISOWeek(t)).padStart(2, "0")}`;
}

/** Build a UTC (Z-form) ISO instant for a local wall-clock date+time in tz */
export function isoFromLocal(dateLocal: string, time: string, tz: string): string {
  const [y, m, d] = dateLocal.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(new TZDate(y, m - 1, d, hh, mm, 0, tz).getTime()).toISOString();
}

export function addDaysToDateKey(dateLocal: string, days: number): string {
  const [y, m, d] = dateLocal.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Map with bounded concurrency; every result settles (never throws). */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
