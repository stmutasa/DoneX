/**
 * Client-safe date & label helpers. Pure formatting — no Node imports.
 */
import {
  differenceInCalendarDays,
  endOfISOWeek,
  format,
  isSameYear,
  setISOWeek,
  setISOWeekYear,
  startOfISOWeek,
} from "date-fns";
import type { RecurrenceRule } from "@/lib/types";
import { PRIORITY_MAP, PRIORITY_RE, PROJECT_RE, TAG_RE, maskLinks } from "@/lib/quickTokens";
import { localDateKey, localTimeKey } from "@/lib/utils";

export function toDate(value: string | Date): Date {
  return typeof value === "string" ? new Date(value) : value;
}

export function isValidDate(d: Date): boolean {
  return !Number.isNaN(d.getTime());
}

/** local "YYYY-MM-DD" */
export function dateKey(value: string | Date = new Date()): string {
  return format(toDate(value), "yyyy-MM-dd");
}

// ── All-day dates ─────────────────────────────────────────────────────────
// An all-day task is stored at midnight in the user's zone (settings.tz). Read
// in a device zone west of that, the instant falls on the evening before, so
// "today" shows as overdue. With a display zone set, all-day dates are read
// as a day in that zone and compared with today there. Unset (the server, or
// before the app knows the zone), everything reads in the device's zone.

// In the browser the zone is remembered, so a cold start reads all-day dates
// right from the first render instead of waiting for /api/auth/me.

const DISPLAY_TZ_KEY = "donex.displayTz";

/** The zone, or null when it is empty or one this runtime doesn't know. */
function knownZone(tz: string | null | undefined): string | null {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

function storedZone(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return knownZone(window.localStorage.getItem(DISPLAY_TZ_KEY));
  } catch {
    return null;
  }
}

let displayTz: string | null = storedZone();
const zoneListeners = new Set<() => void>();

/** Set the zone all-day dates are read in, or null for the device's own. */
export function setDisplayTimeZone(tz: string | null): void {
  const next = knownZone(tz);
  if (next === displayTz) return;
  displayTz = next;
  if (typeof window !== "undefined") {
    try {
      if (next) window.localStorage.setItem(DISPLAY_TZ_KEY, next);
      else window.localStorage.removeItem(DISPLAY_TZ_KEY);
    } catch {
      // storage blocked: the zone still holds for this page load
    }
  }
  // Told after the current render, since this may be called from one.
  queueMicrotask(() => zoneListeners.forEach((listener) => listener()));
}

// Unset is null (not the device's resolved zone): allDayKey then reads in the device's own zone.
export function getDisplayTimeZone(): string | null {
  return displayTz;
}

export function subscribeDisplayTimeZone(listener: () => void): () => void {
  zoneListeners.add(listener);
  return () => {
    zoneListeners.delete(listener);
  };
}

// The React hook over this store lives in src/hooks/useDisplayTimeZone.ts, so
// this module stays importable from server code (route handlers).

/** Midnight in the display zone: how an all-day date is stored. */
function isDisplayMidnight(d: Date): boolean {
  return !!displayTz && localTimeKey(d, displayTz) === "00:00";
}

/**
 * The calendar day ("YYYY-MM-DD") an all-day due date names. Stored values
 * are midnight in the display zone; a value at this device's midnight (an
 * older one, or a date built here) keeps the device's day.
 */
export function allDayKey(value: string | Date): string {
  const d = toDate(value);
  if (!displayTz || !isValidDate(d)) return dateKey(d);
  if (isDisplayMidnight(d)) return localDateKey(d, displayTz);
  if (d.getHours() === 0 && d.getMinutes() === 0) return dateKey(d);
  return localDateKey(d, displayTz);
}

/** Today, in the zone all-day dates are read in. */
function todayKeyForAllDay(): string {
  return displayTz ? localDateKey(new Date(), displayTz) : dateKey();
}

/** Calendar days from today to an all-day date; negative once it has passed. */
function allDayDiff(d: Date): number {
  return differenceInCalendarDays(keyToDate(allDayKey(d)), keyToDate(todayKeyForAllDay()));
}

/** "Today" · "Tomorrow" · "Mon" · "Mon, Aug 12" · "Overdue · 2d" for a whole day. */
function allDayLabel(d: Date): string {
  const day = keyToDate(allDayKey(d));
  const today = keyToDate(todayKeyForAllDay());
  const diff = differenceInCalendarDays(day, today);
  if (diff < 0) return `Overdue · ${-diff}d`;
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff < 7) return format(day, "EEE");
  return isSameYear(day, today) ? format(day, "EEE, MMM d") : format(day, "MMM d, yyyy");
}

/** "3:00 PM" */
export function timeLabel(value: string | Date): string {
  const d = toDate(value);
  if (!isValidDate(d)) return "";
  return format(d, "h:mm a");
}

/** "09:00" → "9:00 AM" */
export function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

export function isOverdue(dueAt: string | null, allDay = false): boolean {
  if (!dueAt) return false;
  const d = toDate(dueAt);
  if (!isValidDate(d)) return false;
  if (allDay) return allDayDiff(d) < 0;
  return d.getTime() < Date.now();
}

/**
 * "Today 3:00 PM" · "Tomorrow" · "Mon, Aug 12" · "Overdue · 2d"
 */
export function dueLabel(dueAt: string | null, allDay = false): string {
  if (!dueAt) return "";
  const d = toDate(dueAt);
  if (!isValidDate(d)) return "";
  if (allDay) return allDayLabel(d);
  const now = new Date();
  const dayDiff = differenceInCalendarDays(d, now);

  if (isOverdue(dueAt)) {
    const behind = -dayDiff;
    if (behind >= 1) return `Overdue · ${behind}d`;
    const hours = Math.floor((now.getTime() - d.getTime()) / 3_600_000);
    if (hours >= 1) return `Overdue · ${hours}h`;
    return "Overdue";
  }

  const time = ` ${timeLabel(d)}`;
  if (dayDiff === 0) return `Today${time}`;
  if (dayDiff === 1) return `Tomorrow${time}`;
  if (dayDiff > 1 && dayDiff < 7) return `${format(d, "EEE")}${time}`;
  const base = isSameYear(d, now) ? format(d, "EEE, MMM d") : format(d, "MMM d, yyyy");
  return `${base} · ${timeLabel(d)}`;
}

/**
 * "By Fri · 3d left" — chip for a live deadline (dueKind "by") task. Without
 * `allDay`, a value at midnight in the display zone counts as a whole day.
 */
export function deadlineChip(dueAt: string | null, allDay?: boolean): string {
  if (!dueAt) return "";
  const d = toDate(dueAt);
  if (!isValidDate(d)) return "";
  const whole = allDay ?? isDisplayMidnight(d);
  const day = whole ? keyToDate(allDayKey(d)) : d;
  const days = whole ? allDayDiff(d) : differenceInCalendarDays(d, new Date());
  if (days < 0) return `Overdue · ${-days}d`;
  if (days === 0) return "By today";
  if (days === 1) return "By tomorrow";
  if (days < 7) return `By ${format(day, "EEE")} · ${days}d left`;
  return `By ${format(day, "MMM d")} · ${days}d left`;
}

/** Section heading for a local date key: "Today" · "Tomorrow" · "Wed, Aug 13" */
export function dayHeading(key: string): string {
  const d = keyToDate(key);
  const diff = differenceInCalendarDays(d, new Date());
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return isSameYear(d, new Date()) ? format(d, "EEE, MMM d") : format(d, "MMM d, yyyy");
}

/** "August" or "August 2027" */
export function monthHeading(key: string): string {
  const d = keyToDate(key);
  return isSameYear(d, new Date()) ? format(d, "MMMM") : format(d, "MMMM yyyy");
}

export function keyToDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** "Friday, August 8" */
export function longDateLine(value: string | Date = new Date()): string {
  return format(toDate(value), "EEEE, MMMM d");
}

/** "just now" · "5m ago" · "3h ago" · "2d ago" · "Aug 3" */
export function relativeTime(value: string | Date): string {
  const d = toDate(value);
  if (!isValidDate(d)) return "";
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 0) {
    const ahead = Math.abs(secs);
    if (ahead < 3600) return `in ${Math.max(1, Math.round(ahead / 60))}m`;
    if (ahead < 86_400) return `in ${Math.round(ahead / 3600)}h`;
    return format(d, "MMM d");
  }
  if (secs < 45) return "just now";
  if (secs < 3600) return `${Math.max(1, Math.round(secs / 60))}m ago`;
  if (secs < 86_400) return `${Math.round(secs / 3600)}h ago`;
  if (secs < 604_800) return `${Math.round(secs / 86_400)}d ago`;
  return isSameYear(d, new Date()) ? format(d, "MMM d") : format(d, "MMM d, yyyy");
}

export function greeting(value: Date = new Date()): string {
  const h = value.getHours();
  if (h < 5) return "Late night";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  if (h < 22) return "Good evening";
  return "Winding down";
}

/** "2026-W32" → "Aug 3 – Aug 9" */
export function weekRangeLabel(weekKey: string): string {
  const [yearPart, weekPart] = weekKey.split("-W");
  const year = Number(yearPart);
  const week = Number(weekPart);
  if (Number.isNaN(year) || Number.isNaN(week)) return weekKey;
  const anchor = setISOWeek(setISOWeekYear(new Date(year, 0, 4), year), week);
  const start = startOfISOWeek(anchor);
  const end = endOfISOWeek(anchor);
  return `${format(start, "MMM d")} – ${format(end, "MMM d")}`;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];
export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** "Every day" · "Every 2 weeks on Mon, Wed" · "Monthly on the 15th" */
export function describeRecurrence(rule: RecurrenceRule | null | undefined): string {
  if (!rule) return "Doesn’t repeat";
  const n = Math.max(1, rule.interval ?? 1);
  switch (rule.freq) {
    case "daily":
      return n === 1 ? "Every day" : `Every ${n} days`;
    case "weekly": {
      const days = (rule.byWeekday ?? [])
        .slice()
        .sort((a, b) => a - b)
        .map((d) => WEEKDAY_SHORT[d])
        .filter(Boolean);
      const base = n === 1 ? "Every week" : `Every ${n} weeks`;
      return days.length ? `${base} on ${days.join(", ")}` : base;
    }
    case "monthly": {
      const base = n === 1 ? "Every month" : n === 3 ? "Quarterly" : `Every ${n} months`;
      return rule.byMonthDay ? `${base} on the ${ordinal(rule.byMonthDay)}` : base;
    }
    case "yearly":
      return n === 1 ? "Every year" : `Every ${n} years`;
    default:
      return "Repeats";
  }
}

/** Local datetime-input value ("2026-08-08T15:00") from an ISO instant */
export function toDateTimeInput(iso: string | null): string {
  if (!iso) return "";
  const d = toDate(iso);
  if (!isValidDate(d)) return "";
  return format(d, "yyyy-MM-dd'T'HH:mm");
}

export function toDateInput(iso: string | null): string {
  if (!iso) return "";
  const d = toDate(iso);
  if (!isValidDate(d)) return "";
  return format(d, "yyyy-MM-dd");
}

/** date/datetime input value → ISO instant */
export function fromDateInput(value: string, allDay: boolean): string | null {
  if (!value) return null;
  const d = allDay ? new Date(`${value}T00:00:00`) : new Date(value);
  return isValidDate(d) ? d.toISOString() : null;
}

// ── Quick-add preview (client mirror of the server parser) ────────────────

export interface QuickPreview {
  title: string;
  project: string | null;
  tags: string[];
  priority: 0 | 1 | 2 | 3 | null;
  when: string | null;
}

const WHEN_PATTERNS: [RegExp, string][] = [
  [/\btoday\b/i, "Today"],
  [/\btomorrow\b|\btmr\b/i, "Tomorrow"],
  [/\btonight\b/i, "Tonight"],
  [/\bnext week\b/i, "Next week"],
  [/\bmon(day)?\b/i, "Monday"],
  [/\btue(s|sday)?\b/i, "Tuesday"],
  [/\bwed(nesday)?\b/i, "Wednesday"],
  [/\bthu(r|rs|rsday)?\b/i, "Thursday"],
  [/\bfri(day)?\b/i, "Friday"],
  [/\bsat(urday)?\b/i, "Saturday"],
  [/\bsun(day)?\b/i, "Sunday"],
  [/\b(at\s*)?\d{1,2}(:\d{2})?\s?(am|pm)\b/i, "Timed"],
];

/** Lightweight, display-only. The server does the real parsing, with the
 *  same token grammar (quickTokens.ts), so the chips match what is saved. */
export function parseQuickPreview(raw: string): QuickPreview {
  const input = raw.normalize("NFC");
  // Links are hidden while reading, as on the server, so no chip comes from one.
  const { masked, unmask } = maskLinks(input);
  const tags: string[] = [];
  let project: string | null = null;
  let priority: QuickPreview["priority"] = null;

  const scanned = masked
    .replace(TAG_RE, (_m, _s, name: string) => {
      tags.push(name);
      return " ";
    })
    .replace(PROJECT_RE, (_m, _s, quoted: string | undefined, word: string | undefined) => {
      const name = unmask((quoted ?? word ?? "").trim());
      if (name && project === null) project = name;
      return " ";
    })
    .replace(PRIORITY_RE, (_m, _s, token: string) => {
      if (priority === null) priority = PRIORITY_MAP[token.toLowerCase()] ?? null;
      return " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  let title = unmask(scanned);

  let when: string | null = null;
  for (const [re, label] of WHEN_PATTERNS) {
    if (re.test(scanned)) {
      when = label;
      break;
    }
  }
  if (!title) title = input.trim();
  return { title, project, tags, priority, when };
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
