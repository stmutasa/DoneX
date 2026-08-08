"use client";

import useSWR from "swr";
import { fetcher, keys } from "@/lib/api";
import type { CalendarEvent } from "@/lib/types";
import { timeLabel } from "@/lib/format";
import { IconCalendar } from "@/components/ui/icons";

export function CalendarStrip() {
  const { data } = useSWR<{ events: CalendarEvent[]; connected: boolean }>(
    keys.calendarToday(),
    fetcher,
    { refreshInterval: 300_000 },
  );

  if (!data?.connected || !data.events.length) return null;

  return (
    <section aria-label="Today’s calendar" className="animate-fade-in">
      <div className="mb-2 flex items-center gap-1.5 px-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">
        <IconCalendar className="h-3.5 w-3.5" />
        Calendar
      </div>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:px-6">
        {data.events.map((ev) => (
          <div
            key={ev.id}
            className="flex min-w-[148px] max-w-[220px] shrink-0 flex-col gap-0.5 rounded-2xl border border-stroke bg-elev px-3 py-2.5"
          >
            <span className="text-[12px] font-medium text-accent">
              {ev.allDay ? "All day" : `${timeLabel(ev.start)} – ${timeLabel(ev.end)}`}
            </span>
            <span className="truncate text-[14px] text-ink">{ev.title}</span>
            {ev.location ? (
              <span className="truncate text-[12px] text-faint">{ev.location}</span>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
