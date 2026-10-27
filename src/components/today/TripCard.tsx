"use client";

import { useState } from "react";
import Link from "next/link";
import { differenceInCalendarDays } from "date-fns";
import useSWR from "swr";
import { fetcher, tripsApi } from "@/lib/api";
import type { Trip } from "@/lib/trips";
import { offsetGapHours, tripNights } from "@/lib/trips";
import { dueLabel, keyToDate } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

interface Payload {
  active: Trip | null;
  upcoming: Trip | null;
  upcomingPacking: string[];
  /** home's UTC offset right now, from the account's time zone */
  homeOffsetMinutes?: number | null;
}

/** Minutes the browser is currently offset from UTC. Only a fallback for home:
 *  a phone set to update its clock takes the destination's zone with it. */
function deviceOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

/** "Tomorrow 8:00 AM", or just the day when the trip ends on an all-day booking. */
function whenLabel(iso: string, day: string | undefined): string {
  return day ? dueLabel(keyToDate(day).toISOString(), true) : dueLabel(iso, false);
}

/** The card's heading. A trip nothing names (a hotel booking with no city in
 *  it) is just "away", or a trip so many days off. */
function headline(trip: Trip, away: boolean): string {
  const place = away ? (trip.here ?? trip.destination) : trip.destination;
  if (away) return place ? `In ${place}` : "Away";
  if (place) return `${place} in a few days`;
  const start = trip.startDay ? keyToDate(trip.startDay) : new Date(trip.start);
  const days = differenceInCalendarDays(start, new Date());
  return days <= 0 ? "Trip today" : days === 1 ? "Trip tomorrow" : `Trip in ${days} days`;
}

/**
 * Travel, taken off the calendar: where you are now, or what's coming and
 * whether you've packed for it. Renders nothing when you're not going
 * anywhere, which is most weeks.
 */
export function TripCard() {
  const toast = useToast();
  const { data } = useSWR<Payload>("/api/trips", fetcher, { refreshInterval: 30 * 60_000 });
  const [making, setMaking] = useState(false);
  const [madeId, setMadeId] = useState<string | null>(null);

  const trip = data?.active ?? data?.upcoming ?? null;
  if (!trip) return null;
  const away = !!data?.active;

  const home = data?.homeOffsetMinutes ?? deviceOffsetMinutes();
  const gap = trip.offsetMinutes !== null ? offsetGapHours(home, trip.offsetMinutes) : 0;

  const makeList = async () => {
    setMaking(true);
    try {
      const res = await tripsApi.packing(trip.start);
      setMadeId(res.noteId);
      const place = trip.destination;
      toast.success(
        res.added > 0
          ? `Packing list${place ? ` for ${place}` : ""} ready — ${res.added} items`
          : place
            ? `The ${place} list is already up to date`
            : "Already on your list",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not build that list");
    } finally {
      setMaking(false);
    }
  };

  return (
    <div className="mb-3 rounded-2xl border border-stroke bg-elev px-4 py-3.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[15px] font-medium text-ink">
          {headline(trip, away)}
        </span>
        <span className="text-[12.5px] text-muted">
          {away
            ? `home ${whenLabel(trip.end, trip.endDay)}`
            : `${tripNights(trip)} ${tripNights(trip) === 1 ? "day" : "days"}`}
        </span>
      </div>

      {away && gap !== 0 ? (
        <p className="mt-1 text-[12.5px] text-muted">
          {Math.abs(gap)}h {gap > 0 ? "ahead of" : "behind"} home — your morning briefing and
          digest follow local time while you’re there.
        </p>
      ) : null}

      {!away ? (
        <p className="mt-1 text-[12.5px] text-muted">
          Leaving {whenLabel(trip.start, trip.startDay)}.
        </p>
      ) : null}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {madeId ? (
          <Link
            href="/notes"
            className="inline-flex min-h-[36px] items-center rounded-xl border border-stroke px-3 text-[13px] font-medium text-accent"
          >
            Open the packing list
          </Link>
        ) : (
          <Button size="sm" loading={making} onClick={() => void makeList()}>
            {away ? "Packing list" : "Make a packing list"}
          </Button>
        )}
      </div>
    </div>
  );
}
