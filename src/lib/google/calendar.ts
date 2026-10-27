/**
 * Google Calendar (REST v3):
 *  - getTodayEvents(): today's events in the user's tz, [] when not connected
 *  - createEventOnCalendar(): timed event on the primary calendar
 */
import "server-only";
import { googleApiError, googleFetch, isGoogleConnected, GOOGLE_NOT_CONNECTED } from "@/lib/google/oauth";
import { settingsRepo } from "@/lib/db/repos";
import { addDaysToDateKey, isoFromLocal, localDateKey } from "@/lib/utils";
import type { CalendarEvent } from "@/lib/types";

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/** Events endpoint for any calendar the connected account can see — "primary"
 *  for the owner's own, or an address for a calendar shared with them. */
function eventsUrlFor(calendarId: string): string {
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
}

/** Carries the HTTP status so callers can tell "not shared with you" (403/404)
 *  apart from "Google is having a bad day". */
export class GoogleCalendarError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "GoogleCalendarError";
    this.status = status;
  }
}

interface GoogleEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface GoogleEvent {
  id?: string;
  summary?: string;
  location?: string;
  status?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
}

export async function getTodayEvents(): Promise<CalendarEvent[]> {
  const tz = settingsRepo.getApp().tz;
  const todayKey = localDateKey(new Date(), tz);
  return listEventsRange(
    isoFromLocal(todayKey, "00:00", tz),
    isoFromLocal(addDaysToDateKey(todayKey, 1), "00:00", tz),
  );
}

/** Google answers a page at a time; a month of a busy calendar runs past one. */
const PAGE_SIZE = "250";
const MAX_PAGES = 10;

/** Google writes a timed event in the calendar's own offset; everything else
 *  speaks UTC, so normalize to the Z form. null when it isn't a real instant. */
function utcInstant(dateTime: string): string | null {
  const ms = Date.parse(dateTime);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Google's shape, in the app's: timed events as UTC instants, all-day ones
 *  as the bare dates Google gives (end exclusive). null for what can't show. */
export function toCalendarEvent(item: GoogleEvent): CalendarEvent | null {
  if (item.status === "cancelled") return null;
  const base = {
    title: item.summary || "(untitled)",
    location: item.location || null,
  };

  const day = item.start?.date;
  if (day && !item.start?.dateTime) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
    const endDay = item.end?.date && item.end.date > day ? item.end.date : addDaysToDateKey(day, 1);
    return { id: item.id ?? day, ...base, start: day, end: endDay, allDay: true };
  }

  const start = item.start?.dateTime ? utcInstant(item.start.dateTime) : null;
  if (!start) return null;
  const end = (item.end?.dateTime && utcInstant(item.end.dateTime)) || start;
  // A flight booked from an email carries its arrival zone on the end.
  const endTimeZone = item.end?.timeZone || item.start?.timeZone;
  return {
    id: item.id ?? start,
    ...base,
    start,
    end,
    allDay: false,
    ...(endTimeZone ? { endTimeZone } : {}),
  };
}

/** Events between two ISO instants; [] when Google is not connected.
 *  `calendarId` defaults to the owner's own calendar; pass an address to read
 *  a calendar someone has shared with the connected account. */
export async function listEventsRange(
  fromIso: string,
  toIso: string,
  calendarId = "primary",
): Promise<CalendarEvent[]> {
  if (!isGoogleConnected()) return [];

  const events: CalendarEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      timeMin: fromIso,
      timeMax: toIso,
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: PAGE_SIZE,
    });
    if (pageToken) params.set("pageToken", pageToken);

    const res = await googleFetch(`${eventsUrlFor(calendarId)}?${params.toString()}`);
    if (!res.ok) {
      const err = await googleApiError(res, "Google Calendar");
      throw new GoogleCalendarError(err.message, res.status);
    }

    const data = (await res.json()) as { items?: GoogleEvent[]; nextPageToken?: string };
    for (const item of data.items ?? []) {
      const event = toCalendarEvent(item);
      if (event) events.push(event);
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  if (pageToken) console.warn(`[calendar] ${calendarId}: stopped after ${MAX_PAGES} pages`);
  return events;
}

export async function createEventOnCalendar(input: {
  title: string;
  start: string; // ISO
  end: string; // ISO
}): Promise<void> {
  if (!isGoogleConnected()) throw new Error(GOOGLE_NOT_CONNECTED);

  const res = await googleFetch(EVENTS_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      summary: input.title,
      start: { dateTime: input.start },
      end: { dateTime: input.end },
    }),
  });
  if (!res.ok) throw await googleApiError(res, "Creating the calendar event");
}
