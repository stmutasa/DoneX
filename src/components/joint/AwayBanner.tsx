"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { dueLabel, keyToDate } from "@/lib/format";

/** Shown on the shared list when the other person is travelling. */
export function AwayBanner() {
  const { data } = useSWR<{
    away: { destination: string; until: string; untilDay?: string | null; who: string } | null;
  }>(
    "/api/trips",
    fetcher,
    { refreshInterval: 30 * 60_000 },
  );
  if (!data?.away) return null;
  // A trip that ends on an all-day booking has no real time to come back at.
  const back = data.away.untilDay
    ? dueLabel(keyToDate(data.away.untilDay).toISOString(), true)
    : dueLabel(data.away.until, false);

  return (
    <p className="mb-4 rounded-2xl border border-stroke bg-sunken px-3.5 py-2.5 text-[13px] text-muted">
      ✈️ {data.away.who} is in {data.away.destination} — back {back}.
    </p>
  );
}
