/**
 * Placing calendar events on local days, for the joint calendar's views.
 *
 * Feeds hand over timed events as instants and all-day events as bare
 * "YYYY-MM-DD" dates (end exclusive). A bare date is its own day wherever you
 * are; an instant lands on the viewer's local day. Pure and client-safe:
 * "local" is the runtime's own zone, which is the viewer's in a browser.
 */
import type { CalendarEvent } from "@/lib/types";
import { addDaysToDateKey } from "@/lib/utils";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function keyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dateOf(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** The local day a moment falls on. An all-day event's bare date is already
 *  its day, wherever you are — parsing it would read it as UTC midnight. */
export function dayKeyOf(iso: string): string {
  return DATE_ONLY.test(iso) ? iso : keyOf(new Date(iso));
}

/** The first and last local days an event covers. All-day ends are
 *  exclusive dates; a timed event that ends at midnight stops the day before. */
export function spanOf(e: CalendarEvent): { first: string; last: string } {
  const first = dayKeyOf(e.start);
  if (DATE_ONLY.test(e.start)) {
    const end = DATE_ONLY.test(e.end) && e.end > e.start ? e.end : addDaysToDateKey(e.start, 1);
    return { first, last: addDaysToDateKey(end, -1) };
  }
  const startMs = Date.parse(e.start);
  const endMs = Date.parse(e.end);
  if (Number.isNaN(endMs) || endMs <= startMs) return { first, last: first };
  const last = keyOf(new Date(endMs - 1));
  return { first, last: last < first ? first : last };
}

export function covers(e: CalendarEvent, key: string): boolean {
  const { first, last } = spanOf(e);
  return first <= key && key <= last;
}

/** When something starts, for ordering: an all-day date counts from local midnight. */
function startMsOf(e: CalendarEvent): number {
  return DATE_ONLY.test(e.start) ? dateOf(e.start).getTime() : Date.parse(e.start);
}

/** All-day first, then by start time — instants, never strings, since feeds
 *  write their offsets differently. */
export function byStart(a: CalendarEvent, b: CalendarEvent): number {
  return Number(b.allDay) - Number(a.allDay) || startMsOf(a) - startMsOf(b);
}

/** The part of a timed event that falls on one local day of the week grid. */
export interface Segment<E extends CalendarEvent = CalendarEvent> {
  e: E;
  /** wall-clock hours on this day, 0–24 */
  startH: number;
  endH: number;
  startMs: number;
  endMs: number;
  /** this day holds the event's start */
  first: boolean;
}

export function segmentOn<E extends CalendarEvent>(e: E, key: string): Segment<E> | null {
  const dayStart = dateOf(key).getTime();
  const dayEnd = dateOf(addDaysToDateKey(key, 1)).getTime();
  const s = Date.parse(e.start);
  if (Number.isNaN(s)) return null;
  const en = Math.max(s, Date.parse(e.end) || s);
  if (s >= dayEnd || (en <= dayStart && s < dayStart)) return null;
  const hoursAt = (ms: number) => {
    const d = new Date(ms);
    return d.getHours() + d.getMinutes() / 60;
  };
  return {
    e,
    startH: s < dayStart ? 0 : hoursAt(s),
    endH: en >= dayEnd ? 24 : hoursAt(en),
    startMs: Math.max(s, dayStart),
    endMs: Math.min(en, dayEnd),
    first: s >= dayStart,
  };
}

/** Google-Calendar-style lanes: overlapping events share the column width. */
export function layoutLanes(segments: Segment[]): Map<string, { lane: number; lanes: number }> {
  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);
  const result = new Map<string, { lane: number; lanes: number }>();
  let cluster: Segment[] = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    if (cluster.length === 0) return;
    const laneEnds: number[] = [];
    const laneOf = new Map<string, number>();
    for (const seg of cluster) {
      let lane = laneEnds.findIndex((end) => end <= seg.startMs);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(seg.endMs);
      } else {
        laneEnds[lane] = seg.endMs;
      }
      laneOf.set(seg.e.id, lane);
    }
    for (const seg of cluster) {
      result.set(seg.e.id, { lane: laneOf.get(seg.e.id) ?? 0, lanes: laneEnds.length });
    }
    cluster = [];
    clusterEnd = -Infinity;
  };
  for (const seg of sorted) {
    if (cluster.length > 0 && seg.startMs >= clusterEnd) flush();
    cluster.push(seg);
    clusterEnd = Math.max(clusterEnd, seg.endMs);
  }
  flush();
  return result;
}
