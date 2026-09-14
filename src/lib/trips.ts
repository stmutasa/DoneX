/**
 * Spotting a trip in the calendar.
 *
 * Flights, hotels and rental cars land on the calendar automatically from
 * confirmation emails, which makes them a reliable signal that you'll be
 * somewhere else — no separate "I'm travelling" switch to remember. Shifts
 * move week to week, so this reads the calendar fresh rather than assuming a
 * pattern. Pure and client-safe.
 */
import type { CalendarEvent } from "@/lib/types";

export type LegKind = "flight" | "stay" | "car";

export interface TravelLeg {
  kind: LegKind;
  title: string;
  start: string;
  end: string;
  /** where this leg points, when the title says so */
  destination: string | null;
  /** UTC offset in minutes at the far end, when the calendar carried one */
  offsetMinutes: number | null;
}

export interface Trip {
  /** first departure */
  start: string;
  /** end of the last leg home */
  end: string;
  destination: string;
  /** destination's UTC offset in minutes, when it could be read */
  offsetMinutes: number | null;
  legs: TravelLeg[];
}

/** How far ahead a trip counts as "coming up" for the packing nudge. */
export const PACKING_NOTICE_DAYS = 4;

const FLIGHT_RE = /\b(flight|airlines?|airways)\b/i;
const STAY_RE = /\b(hotel|inn|resort|airbnb|hostel|lodge)\b/i;
const CAR_RE = /\b(rental car|car rental|hertz|avis|enterprise rent)\b/i;

/** "Flight to Dallas — Southwest WN 2845 (LGA → DAL)" → "Dallas" */
function destinationFrom(title: string): string | null {
  const to = /\b(?:flight|fly|travel|trip)\s+to\s+([A-Za-z][A-Za-z .'-]{1,40})/i.exec(title);
  if (to) return tidy(to[1]);

  // "(LGA → DAL)" or "(LGA - DAL)" — the airport we end up at
  const pair = /\(([A-Z]{3})\s*(?:→|->|-|–|to)\s*([A-Z]{3})\)/.exec(title);
  if (pair) return pair[2];

  // "Hotel — The Westin Dallas Stonebriar" carries a place too, but it is not
  // reliably a city; leave it to the flight leg to name the trip.
  return null;
}

function tidy(value: string): string {
  return value
    .replace(/[—–-]\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The offset an ISO string carries, in minutes. "…-05:00" → -300. */
export function offsetOf(iso: string): number | null {
  const m = /([+-])(\d{2}):?(\d{2})$/.exec(iso.trim());
  if (!m) return null; // a plain "Z" or a bare local time tells us nothing
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

export function classify(title: string): LegKind | null {
  if (FLIGHT_RE.test(title)) return "flight";
  if (STAY_RE.test(title)) return "stay";
  if (CAR_RE.test(title)) return "car";
  return null;
}

export function travelLegs(events: CalendarEvent[]): TravelLeg[] {
  const legs: TravelLeg[] = [];
  for (const e of events) {
    const kind = classify(e.title);
    if (!kind) continue;
    legs.push({
      kind,
      title: e.title,
      start: e.start,
      end: e.end,
      destination: destinationFrom(e.title),
      offsetMinutes: offsetOf(e.end) ?? offsetOf(e.start),
    });
  }
  return legs.sort((a, b) => a.start.localeCompare(b.start));
}

/** Legs within a day of each other belong to the same trip. */
const GAP_MS = 36 * 60 * 60 * 1000;

export function detectTrips(events: CalendarEvent[]): Trip[] {
  const legs = travelLegs(events);
  if (legs.length === 0) return [];

  const clusters: TravelLeg[][] = [];
  for (const leg of legs) {
    const current = clusters[clusters.length - 1];
    const prevEnd = current ? Date.parse(current[current.length - 1].end) : 0;
    if (current && Date.parse(leg.start) - prevEnd <= GAP_MS) current.push(leg);
    else clusters.push([leg]);
  }

  return clusters
    .map((cluster) => {
      // A single rental car or a one-night hotel is an errand, not a trip.
      const hasFlight = cluster.some((l) => l.kind === "flight");
      const spansNight = cluster.some(
        (l) => Date.parse(l.end) - Date.parse(l.start) > 20 * 60 * 60 * 1000,
      );
      if (!hasFlight && !spansNight) return null;

      const named = cluster.find((l) => l.destination);
      const offsetLeg = cluster.find((l) => l.offsetMinutes !== null);
      return {
        start: cluster[0].start,
        end: cluster.reduce((latest, l) => (l.end > latest ? l.end : latest), cluster[0].end),
        destination: named?.destination ?? "your trip",
        offsetMinutes: offsetLeg?.offsetMinutes ?? null,
        legs: cluster,
      } satisfies Trip;
    })
    .filter((t): t is Trip => t !== null);
}

export function activeTrip(trips: Trip[], now: Date = new Date()): Trip | null {
  const at = now.getTime();
  return trips.find((t) => Date.parse(t.start) <= at && at <= Date.parse(t.end)) ?? null;
}

/** The next trip starting within `days`, for the packing nudge. */
export function upcomingTrip(trips: Trip[], days: number, now: Date = new Date()): Trip | null {
  const at = now.getTime();
  const limit = at + days * 86_400_000;
  return (
    trips.find((t) => {
      const start = Date.parse(t.start);
      return start > at && start <= limit;
    }) ?? null
  );
}

/** Whole days the trip covers, counting the day you leave. */
export function tripNights(trip: Trip): number {
  const ms = Date.parse(trip.end) - Date.parse(trip.start);
  return Math.max(1, Math.round(ms / 86_400_000));
}

const ALWAYS = [
  "Phone charger",
  "Toothbrush and toiletries",
  "Medication",
  "Wallet, cards, ID",
  "Headphones",
];

/**
 * A starting checklist, shaped by what the trip actually looks like rather
 * than a fixed template — you can edit it like any other list.
 */
export function packingList(trip: Trip): string[] {
  const items = [...ALWAYS];
  const nights = tripNights(trip);
  items.push(`Clothes for ${nights} ${nights === 1 ? "day" : "days"}`);

  if (trip.legs.some((l) => l.kind === "flight")) {
    items.push("Boarding pass on phone");
  }
  if (trip.legs.some((l) => l.kind === "car")) {
    items.push("Driver's licence for the rental");
  }
  if (trip.legs.some((l) => l.kind === "stay")) {
    items.push("Hotel confirmation");
  }
  if (nights >= 3) {
    items.push("Laundry plan", "Hold the mail");
  }
  return items;
}

/**
 * The wall clock at a place with this UTC offset. Shifting the instant and
 * reading it back in UTC gives the destination's time without needing a
 * timezone database — good enough for a trip-length window, which is all
 * this is used for.
 */
export function wallClockAt(
  now: Date,
  offsetMinutes: number,
): { time: string; dateKey: string; weekday: number } {
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    time: `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`,
    dateKey: `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`,
    weekday: shifted.getUTCDay(),
  };
}

/** Hours between home and where you are, for the "3h ahead" line. */
export function offsetGapHours(homeOffsetMinutes: number, tripOffsetMinutes: number): number {
  return Math.round((tripOffsetMinutes - homeOffsetMinutes) / 60);
}
