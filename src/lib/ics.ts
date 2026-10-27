/**
 * ICS calendar-feed ingestion for the joint calendar.
 *
 * Feeds are capability URLs the owner pastes in Settings — an iCloud
 * public-calendar link (webcal://…) or a Google "secret address in iCal
 * format". Fetched server-side with a short cache so two phones refreshing
 * don't hammer anyone's calendar host; recurring events are expanded by
 * node-ical, overrides and cancellations included.
 */
import "server-only";
import ical, { type EventInstance, type VEvent } from "node-ical";
import type { CalendarEvent } from "@/lib/types";
import { addDaysToDateKey, isoFromLocal } from "@/lib/utils";

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; body: string }>();

function normalizeUrl(raw: string): string {
  const url = raw.trim();
  return url.replace(/^webcal:\/\//i, "https://");
}

/** Carries the HTTP status so callers can explain *why* a feed failed —
 *  a 404 on a Google "public address" means the calendar simply isn't public. */
export class IcsFetchError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "IcsFetchError";
    this.status = status;
  }
}

async function fetchIcsBody(url: string): Promise<string> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.body;
  let res: Response;
  try {
    res = await fetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { accept: "text/calendar, text/plain, */*" },
    });
  } catch {
    throw new IcsFetchError("Could not reach the calendar host", 0);
  }
  if (!res.ok) throw new IcsFetchError(`Calendar feed answered HTTP ${res.status}`, res.status);
  const body = await res.text();
  cache.set(url, { at: Date.now(), body });
  return body;
}

interface IcsWindowArgs {
  url: string;
  from: Date;
  to: Date;
  /** IANA zone whose midnights bound an all-day event; the server's when omitted */
  tz?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Plenty for a 45-day window; stops a runaway rule from flooding the view. */
const MAX_PER_EVENT = 200;

// node-ical models text fields as string | {val, params}
const text = (v: unknown): string =>
  typeof v === "string" ? v : v && typeof v === "object" && "val" in v ? String((v as { val: unknown }).val) : "";

/** node-ical builds a date-only value at the server's local midnight, so its
 *  local fields are the calendar date. */
function dateKeyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The zone a time was written in. node-ical reports a plain Z time as
 *  "Etc/UTC", which says nothing about where the event is. */
function zoneOf(d: Date): string | undefined {
  const tz = (d as Date & { tz?: unknown }).tz;
  return typeof tz === "string" && tz && !/^(Etc\/)?(UTC|GMT)$/i.test(tz) ? tz : undefined;
}

/**
 * The events of a parsed feed that overlap [from, to): recurrences expanded,
 * moved and retitled occurrences (RECURRENCE-ID) applied, cancelled events
 * and occurrences dropped. Timed events come back as UTC instants; all-day
 * events as bare "YYYY-MM-DD" dates with an exclusive end, the way Google
 * sends them.
 */
export function eventsFromIcs(body: string, { from, to, tz }: Omit<IcsWindowArgs, "url">): CalendarEvent[] {
  const parsed = ical.sync.parseICS(body);
  const zone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fromMs = from.getTime();
  const toMs = to.getTime();
  // An all-day event runs from local midnight to local midnight where you live.
  const midnight = (key: string) => Date.parse(isoFromLocal(key, "00:00", zone));
  const out: { at: number; event: CalendarEvent }[] = [];

  for (const key of Object.keys(parsed)) {
    const item = parsed[key];
    if (!item || item.type !== "VEVENT") continue;
    const ev = item as VEvent;
    if (ev.status === "CANCELLED" || !ev.start) continue;

    let instances: EventInstance[];
    try {
      // A day wider than the window so events straddling the edges land; the
      // exact overlap is decided below.
      instances = ical.expandRecurringEvent(ev, {
        from: new Date(fromMs - DAY_MS),
        to: new Date(toMs + DAY_MS),
        expandOngoing: true,
      });
    } catch {
      continue;
    }

    const uid = text(ev.uid) || key;
    for (const inst of instances.slice(0, MAX_PER_EVENT)) {
      // One occurrence can be called off by an override of its own.
      if (inst.event.status === "CANCELLED") continue;
      const base = {
        id: `${uid}:${inst.start.toISOString()}`,
        title: text(inst.summary) || "(untitled)",
        location: text(inst.event.location ?? ev.location) || null,
      };

      if (inst.isFullDay) {
        const start = dateKeyOf(inst.start);
        const endKey = dateKeyOf(inst.end);
        const end = endKey > start ? endKey : addDaysToDateKey(start, 1);
        const at = midnight(start);
        if (at >= toMs || midnight(end) <= fromMs) continue;
        out.push({ at, event: { ...base, start, end, allDay: true } });
        continue;
      }

      const startMs = inst.start.getTime();
      const endMs = Math.max(startMs, inst.end.getTime());
      // Half-open overlap, like Google's timeMin/timeMax.
      if (startMs >= toMs || (endMs <= fromMs && startMs < fromMs)) continue;
      const endTimeZone = zoneOf(inst.end) ?? zoneOf(inst.start);
      out.push({
        at: startMs,
        event: {
          ...base,
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
          allDay: false,
          ...(endTimeZone ? { endTimeZone } : {}),
        },
      });
    }
  }

  return out.sort((a, b) => a.at - b.at).map((o) => o.event);
}

/** Events (recurrences expanded) between from/to. Throws on unreachable feeds. */
export async function icsEventsBetween({ url, ...window }: IcsWindowArgs): Promise<CalendarEvent[]> {
  const body = await fetchIcsBody(normalizeUrl(url));
  return eventsFromIcs(body, window);
}
