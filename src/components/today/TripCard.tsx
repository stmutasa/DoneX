"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { fetcher, tripsApi } from "@/lib/api";
import type { Trip } from "@/lib/trips";
import { offsetGapHours, tripNights } from "@/lib/trips";
import { dueLabel } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

interface Payload {
  active: Trip | null;
  upcoming: Trip | null;
  upcomingPacking: string[];
}

/** Minutes the browser is currently offset from UTC, as a home baseline. */
function homeOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
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

  const gap =
    trip.offsetMinutes !== null ? offsetGapHours(homeOffsetMinutes(), trip.offsetMinutes) : 0;

  const makeList = async () => {
    setMaking(true);
    try {
      const res = await tripsApi.packing();
      setMadeId(res.noteId);
      toast.success(res.added > 0 ? `Packing list ready — ${res.added} items` : "Already on your list");
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
          {away ? `In ${trip.destination}` : `${trip.destination} in a few days`}
        </span>
        <span className="text-[12.5px] text-muted">
          {away
            ? `home ${dueLabel(trip.end, false)}`
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
          Leaving {dueLabel(trip.start, false)}.
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
