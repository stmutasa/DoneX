/**
 * ICS calendar-feed ingestion for the joint calendar.
 *
 * Feeds are capability URLs the owner pastes in Settings — an iCloud
 * public-calendar link (webcal://…) or a Google "secret address in iCal
 * format". Fetched server-side with a short cache so two phones refreshing
 * don't hammer anyone's calendar host; recurring events are expanded via the
 * RRULEs node-ical exposes.
 */
import "server-only";
import ical, { type VEvent } from "node-ical";
import type { CalendarEvent } from "@/lib/types";

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
}

/** Events (recurrences expanded) between from/to. Throws on unreachable feeds. */
export async function icsEventsBetween({ url, from, to }: IcsWindowArgs): Promise<CalendarEvent[]> {
  const body = await fetchIcsBody(normalizeUrl(url));
  const parsed = ical.sync.parseICS(body);
  const out: CalendarEvent[] = [];

  for (const key of Object.keys(parsed)) {
    const item = parsed[key];
    if (!item || item.type !== "VEVENT") continue;
    const ev = item as VEvent;
    const allDay = (ev.datetype ?? "") === "date";
    const durationMs =
      ev.end && ev.start ? ev.end.getTime() - ev.start.getTime() : 60 * 60 * 1000;

    const pushEvent = (start: Date) => {
      const end = new Date(start.getTime() + durationMs);
      if (end < from || start > to) return;
      // node-ical models text fields as string | {val, params}
      const text = (v: unknown): string =>
        typeof v === "string" ? v : v && typeof v === "object" && "val" in v ? String((v as { val: unknown }).val) : "";
      out.push({
        id: `${text(ev.uid) || key}:${start.toISOString()}`,
        title: text(ev.summary) || "(untitled)",
        start: start.toISOString(),
        end: end.toISOString(),
        allDay,
        location: text(ev.location) || null,
      });
    };

    if (ev.rrule) {
      // Expand a little wider than the window so events straddling the edges land.
      const occurrences = ev.rrule.between(
        new Date(from.getTime() - durationMs),
        to,
        true,
      );
      const exdates = new Set(
        Object.values(ev.exdate ?? {}).map((d) => (d as Date).toISOString().slice(0, 10)),
      );
      for (const occ of occurrences.slice(0, 200)) {
        if (exdates.has(occ.toISOString().slice(0, 10))) continue;
        pushEvent(occ);
      }
    } else if (ev.start) {
      pushEvent(ev.start);
    }
  }

  return out.sort((a, b) => a.start.localeCompare(b.start));
}
