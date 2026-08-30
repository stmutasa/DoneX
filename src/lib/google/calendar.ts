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

interface GoogleEvent {
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

/** Events between two ISO instants; [] when Google is not connected.
 *  `calendarId` defaults to the owner's own calendar; pass an address to read
 *  a calendar someone has shared with the connected account. */
export async function listEventsRange(
  fromIso: string,
  toIso: string,
  calendarId = "primary",
): Promise<CalendarEvent[]> {
  if (!isGoogleConnected()) return [];

  const params = new URLSearchParams({
    timeMin: fromIso,
    timeMax: toIso,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "100",
  });

  const res = await googleFetch(`${eventsUrlFor(calendarId)}?${params.toString()}`);
  if (!res.ok) {
    const err = await googleApiError(res, "Google Calendar");
    throw new GoogleCalendarError(err.message, res.status);
  }

  const data = (await res.json()) as { items?: GoogleEvent[] };
  const events: CalendarEvent[] = [];
  for (const item of data.items ?? []) {
    if (item.status === "cancelled") continue;
    const start = item.start?.dateTime || item.start?.date;
    if (!start) continue;
    events.push({
      id: item.id ?? start,
      title: item.summary || "(untitled)",
      start,
      end: item.end?.dateTime || item.end?.date || start,
      allDay: !!item.start?.date,
      location: item.location || null,
    });
  }
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
