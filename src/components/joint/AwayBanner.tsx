"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/api";
import { dueLabel } from "@/lib/format";

/** Shown on the shared list when the other person is travelling. */
export function AwayBanner() {
  const { data } = useSWR<{ away: { destination: string; until: string; who: string } | null }>(
    "/api/trips",
    fetcher,
    { refreshInterval: 30 * 60_000 },
  );
  if (!data?.away) return null;

  return (
    <p className="mb-4 rounded-2xl border border-stroke bg-sunken px-3.5 py-2.5 text-[13px] text-muted">
      ✈️ {data.away.who} is in {data.away.destination} — back {dueLabel(data.away.until, false)}.
    </p>
  );
}
