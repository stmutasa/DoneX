/**
 * Spotting a trip in the calendar.
 *
 * Flights, hotels and rental cars land on the calendar automatically from
 * confirmation emails, which makes them a reliable signal that you'll be
 * somewhere else — no separate "I'm travelling" switch to remember. Shifts
 * move week to week, so this reads the calendar fresh rather than assuming a
 * pattern. Pure and client-safe.
 */
import { tzOffset } from "@date-fns/tz";
import type { CalendarEvent } from "@/lib/types";
import { addDaysToDateKey, isoFromLocal } from "@/lib/utils";

export type LegKind = "flight" | "stay" | "car";

export interface TravelLeg {
  kind: LegKind;
  title: string;
  /** an instant; an all-day booking starts at local midnight */
  start: string;
  /** an instant; an all-day booking ends at the midnight after its last day */
  end: string;
  /** an all-day booking's first and last dates — it has no clock times */
  startDay?: string;
  endDay?: string;
  /** where this leg points, when the title says so */
  destination: string | null;
  /** IANA zone at the far end, when the calendar named one */
  timeZone?: string | null;
  /** UTC offset in minutes at the far end, when the calendar carried one */
  offsetMinutes: number | null;
}

export interface Trip {
  /** first departure */
  start: string;
  /** end of the last leg home */
  end: string;
  /** set when the trip starts on an all-day booking: the date, with no time to show */
  startDay?: string;
  /** set when the trip ends on an all-day booking: its last date */
  endDay?: string;
  /** the place the trip is about — where you spend longest; null when nothing names it */
  destination: string | null;
  /** where you are now on a trip with several stops, once you've reached one */
  here?: string;
  /** IANA zone the trip's clock follows, when the calendar named one */
  timeZone?: string | null;
  /** destination's UTC offset in minutes, when it could be read */
  offsetMinutes: number | null;
  legs: TravelLeg[];
}

export interface TripOptions {
  /** home zone, where an all-day booking's midnights fall; the runtime's own when omitted */
  tz?: string;
  /** when to read the destination's offset, so it stays right across a DST change */
  now?: Date;
}

/** How far ahead a trip counts as "coming up" for the packing nudge. */
export const PACKING_NOTICE_DAYS = 4;

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const FLIGHT_RE = /\b(flight|airlines?|airways)\b/i;
const STAY_RE = /\b(hotel|inn|resort|airbnb|hostel|lodge)\b/i;
const CAR_RE = /\b(rental car|car rental|hertz|avis|enterprise rent)\b/i;
const AIRPORTS_RE = /\(([A-Z]{3})\s*(?:→|->|-|–|to)\s*([A-Z]{3})\)/;

/** "Flight to Dallas — Southwest WN 2845 (LGA → DAL)" → "Dallas" */
function destinationFrom(title: string): string | null {
  const to = /\b(?:flight|fly|travel|trip)\s+to\s+([A-Za-z][A-Za-z .'-]{1,40})/i.exec(title);
  // "New York - Delta DL 2845": a spaced dash ends the place; "Winston-Salem" keeps its own.
  if (to) return tidy(to[1].split(/\s+[-—–]/)[0]);

  // "(LGA → DAL)" or "(LGA - DAL)" — the airport we end up at
  const pair = AIRPORTS_RE.exec(title);
  if (pair) return pair[2];

  // "Hotel — The Westin Dallas Stonebriar" carries a place too, but it is not
  // reliably a city; leave it to the flight leg to name the trip.
  return null;
}

/** "(DEN → LGA)" → "DEN": where the flight home leaves from. */
function originFrom(title: string): string | null {
  return AIRPORTS_RE.exec(title)?.[1] ?? null;
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

/** A zone's UTC offset in minutes at a moment; null for a zone nobody knows. */
export function zoneOffsetMinutes(timeZone: string, at: Date = new Date()): number | null {
  const minutes = tzOffset(timeZone, at);
  return Number.isFinite(minutes) ? minutes : null;
}

/** The zone, if this runtime knows it by that name. */
function knownZone(timeZone: string | undefined): string | null {
  if (!timeZone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return null;
  }
}

/** A bare date's local midnight, as an instant. */
function midnightOf(day: string, tz: string | undefined): string {
  if (tz) return isoFromLocal(day, "00:00", tz);
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toISOString();
}

export function classify(title: string): LegKind | null {
  if (FLIGHT_RE.test(title)) return "flight";
  if (STAY_RE.test(title)) return "stay";
  if (CAR_RE.test(title)) return "car";
  return null;
}

export function travelLegs(events: CalendarEvent[], opts: TripOptions = {}): TravelLeg[] {
  const now = opts.now ?? new Date();
  const legs: TravelLeg[] = [];
  for (const e of events) {
    const kind = classify(e.title);
    if (!kind) continue;
    const zone = knownZone(e.endTimeZone);
    const leg: TravelLeg = {
      kind,
      title: e.title,
      start: e.start,
      end: e.end,
      destination: destinationFrom(e.title),
      timeZone: zone,
      // The zone, read for now, follows DST; an offset in the string is a fallback.
      offsetMinutes: zone ? zoneOffsetMinutes(zone, now) : (offsetOf(e.end) ?? offsetOf(e.start)),
    };
    if (DATE_ONLY.test(e.start)) {
      // An all-day booking: dates only, end exclusive.
      const endKey = DATE_ONLY.test(e.end) && e.end > e.start ? e.end : addDaysToDateKey(e.start, 1);
      leg.start = midnightOf(e.start, opts.tz);
      leg.end = midnightOf(endKey, opts.tz);
      leg.startDay = e.start;
      leg.endDay = addDaysToDateKey(endKey, -1);
    }
    if (Number.isNaN(Date.parse(leg.start)) || Number.isNaN(Date.parse(leg.end))) continue;
    legs.push(leg);
  }
  return legs.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** Legs within a day of each other belong to the same trip. */
const GAP_MS = 36 * 60 * 60 * 1000;
/** A flight back within this long of a flight out is the same trip, with no hotel between. */
const RETURN_MS = 21 * DAY_MS;
/** A booking longer than this has someone sleeping away from home. */
const NIGHT_MS = 20 * 60 * 60 * 1000;

const spansNight = (l: TravelLeg) => Date.parse(l.end) - Date.parse(l.start) > NIGHT_MS;

/** "(DEN → LGA)" → { from: "DEN", to: "LGA" } */
function airportsOf(l: TravelLeg): { from: string; to: string } | null {
  const pair = AIRPORTS_RE.exec(l.title);
  return pair ? { from: pair[1], to: pair[2] } : null;
}

/** A stay or car booked in the home zone: home-side (an airport hotel, a car
 *  to the airport), or typed in at home and carrying the home calendar's zone. */
function homeSide(l: TravelLeg, opts: TripOptions): boolean {
  return l.kind !== "flight" && !!opts.tz && l.timeZone === opts.tz;
}

/** How a group of legs starts, and which flight (if any) takes you home. */
function shapeOf(cluster: TravelLeg[], opts: TripOptions): { startLeg: TravelLeg; flightHome: TravelLeg | null } {
  // An all-day booking has a date but no time: a timed leg that starts on its
  // first day (the flight out) starts the trip.
  const first = cluster[0];
  const last = cluster[cluster.length - 1];
  const startLeg = first.startDay
    ? (cluster.find((l) => !l.startDay && Date.parse(l.start) < Date.parse(first.start) + DAY_MS) ?? first)
    : first;

  // The last flight goes home only if something came before it away from
  // home: a flight out, or a night somewhere other than home. A flight that
  // lands outside the home zone never does — the night before at the
  // airport hotel leaves it as the way out.
  const landsAway = !!opts.tz && !!last.timeZone && last.timeZone !== opts.tz;
  const awayBefore = cluster.some(
    (l) => l !== last && (l.kind === "flight" || (spansNight(l) && !homeSide(l, opts))),
  );
  const flightHome = last.kind === "flight" && last !== startLeg && !landsAway && awayBefore ? last : null;
  return { startLeg, flightHome };
}

/**
 * A flight out and a flight back with nothing booked between (staying with
 * family) fall more than a day apart; they are still one trip when the
 * second leaves from where the first landed, or, when the titles name no
 * airports, lands back in the home zone.
 */
function continues(prev: TravelLeg[], prevEnd: number, next: TravelLeg[], opts: TripOptions): boolean {
  const out = prev[prev.length - 1];
  const back = next[0];
  if (out.kind !== "flight" || back.kind !== "flight") return false;
  if (Date.parse(back.start) - prevEnd > RETURN_MS) return false;
  if (shapeOf(prev, opts).flightHome) return false; // already home
  const landed = airportsOf(out)?.to;
  const leaves = airportsOf(back)?.from;
  if (landed && leaves) return landed === leaves;
  return !!opts.tz && back.timeZone === opts.tz;
}

/**
 * The place a trip is about: the arrival followed by the longest time on the
 * ground, so a connection doesn't name it. Stays carry no place of their own.
 */
function mainStop(away: TravelLeg[], cluster: TravelLeg[], tripEnd: number): TravelLeg | undefined {
  let best: TravelLeg | undefined;
  let longest = -Infinity;
  for (const leg of away) {
    if (leg.kind !== "flight" || !leg.destination) continue;
    const landed = Date.parse(leg.end);
    const next = cluster.find((l) => l !== leg && l.kind === "flight" && Date.parse(l.start) >= landed);
    const ground = (next ? Date.parse(next.start) : tripEnd) - landed;
    if (ground > longest) {
      best = leg;
      longest = ground;
    }
  }
  return best ?? away.find((l) => l.destination);
}

/**
 * The leg whose zone the trip's clock follows: the latest one that has begun,
 * so a multi-stop trip moves with you. A flight's zone is where it lands,
 * home included. A stay or car in the home zone is passed over while any
 * other zone is on the trip, but until something away has begun the clock
 * stays home: the night at the airport hotel is still home time.
 */
function clockLeg(away: TravelLeg[], opts: TripOptions): TravelLeg | undefined {
  const at = (opts.now ?? new Date()).getTime();
  const begun = (legs: TravelLeg[]) => legs.filter((l) => Date.parse(l.start) <= at);
  const zoned = away.filter((l) => l.timeZone);
  if (zoned.length === 0) {
    // Only offsets written into the times to go on.
    const offsets = away.filter((l) => l.offsetMinutes !== null);
    return begun(offsets).pop() ?? offsets[0];
  }
  const trusted = zoned.filter((l) => !homeSide(l, opts));
  const pool = trusted.length > 0 ? trusted : zoned;
  const begunAway = begun(pool);
  if (begunAway.length > 0) return begunAway[begunAway.length - 1];
  if (begun(away).length > 0) return begun(zoned).pop();
  return pool[0];
}

export function detectTrips(events: CalendarEvent[], opts: TripOptions = {}): Trip[] {
  const legs = travelLegs(events, opts);
  if (legs.length === 0) return [];
  const at = (opts.now ?? new Date()).getTime();

  // The gap is measured from the latest end so far, so a short stay inside a
  // long car rental doesn't split the flight home off into a trip of its own.
  const clusters: { legs: TravelLeg[]; end: number }[] = [];
  for (const leg of legs) {
    const current = clusters[clusters.length - 1];
    const end = Date.parse(leg.end);
    if (current && Date.parse(leg.start) - current.end <= GAP_MS) {
      current.legs.push(leg);
      current.end = Math.max(current.end, end);
    } else if (current && continues(current.legs, current.end, [leg], opts)) {
      current.legs.push(leg);
      current.end = Math.max(current.end, end);
    } else {
      clusters.push({ legs: [leg], end });
    }
  }

  return clusters
    .map(({ legs: cluster }) => {
      // A single rental car or a one-night hotel is an errand, not a trip.
      const hasFlight = cluster.some((l) => l.kind === "flight");
      if (!hasFlight && !cluster.some(spansNight)) return null;

      const { startLeg, flightHome } = shapeOf(cluster, opts);
      const away = cluster.filter((l) => l !== flightHome);

      // An all-day booking's last day ends the trip, unless a timed leg (the
      // flight home) ends on that day.
      const lastEnd = Math.max(...cluster.map((l) => Date.parse(l.end)));
      const lastLeg = cluster.find((l) => Date.parse(l.end) === lastEnd) ?? cluster[cluster.length - 1];
      const endLeg = lastLeg.endDay
        ? (cluster
            .filter((l) => !l.endDay && Date.parse(l.end) > lastEnd - DAY_MS)
            .sort((a, b) => Date.parse(b.end) - Date.parse(a.end))[0] ?? lastLeg)
        : lastLeg;

      // When the flight out is missing, where the flight home leaves from is
      // the best name there is.
      const named =
        mainStop(away, cluster, Date.parse(endLeg.end))?.destination ??
        (flightHome ? originFrom(flightHome.title) : null);
      const here = away.filter((l) => l.destination && Date.parse(l.start) <= at).pop()?.destination;
      const zoned = clockLeg(away, opts);

      const trip: Trip = {
        start: startLeg.start,
        end: endLeg.end,
        destination: named ?? null,
        timeZone: zoned?.timeZone ?? null,
        offsetMinutes: zoned?.offsetMinutes ?? null,
        legs: cluster,
      };
      if (here) trip.here = here;
      if (startLeg.startDay) trip.startDay = startLeg.startDay;
      if (endLeg.endDay) trip.endDay = endLeg.endDay;
      return trip;
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
