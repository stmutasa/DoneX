"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import type { CalendarEvent, Task } from "@/lib/types";
import { dayHeading, timeLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SkeletonRows } from "@/components/ui/Misc";

interface Entry extends CalendarEvent {
  who: "owner" | "partner";
}

interface Payload {
  events: Entry[];
  tasks: Task[];
  warnings: string[];
}

const WHO_DOT: Record<Entry["who"], string> = {
  owner: "bg-sunrise",
  partner: "bg-accent",
};

/** Seven days of both calendars plus dated joint tasks, grouped by day. */
export function JointCalendar({ names }: { names: { owner: string; partner: string } }) {
  const { data, isLoading } = useSWR<Payload>("/api/joint/calendar?days=7", fetcher, {
    refreshInterval: 5 * 60_000,
  });

  const byDay = useMemo(() => {
    const map = new Map<string, { events: Entry[]; tasks: Task[] }>();
    const dayOf = (iso: string) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    for (const e of data?.events ?? []) {
      const key = dayOf(e.start);
      const bucket = map.get(key) ?? { events: [], tasks: [] };
      bucket.events.push(e);
      map.set(key, bucket);
    }
    for (const t of data?.tasks ?? []) {
      if (!t.dueAt) continue;
      const key = dayOf(t.dueAt);
      const bucket = map.get(key) ?? { events: [], tasks: [] };
      bucket.tasks.push(t);
      map.set(key, bucket);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data]);

  if (isLoading) return <SkeletonRows rows={4} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 px-1 text-[12px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("h-2.5 w-2.5 rounded-full", WHO_DOT.owner)} /> {names.owner}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className={cn("h-2.5 w-2.5 rounded-full", WHO_DOT.partner)} /> {names.partner}
        </span>
      </div>

      {(data?.warnings ?? []).map((w) => (
        <p key={w} className="rounded-2xl border border-stroke bg-sunken px-3.5 py-2.5 text-[13px] text-warn">
          {w}
        </p>
      ))}

      {byDay.length === 0 ? (
        <p className="rounded-2xl border border-stroke bg-elev px-4 py-6 text-center text-[14px] text-muted">
          Nothing on either calendar this week. Add feeds in Settings → Shared list.
        </p>
      ) : (
        byDay.map(([key, bucket]) => (
          <section key={key}>
            <p className="mb-1.5 px-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">
              {dayHeading(key)}
            </p>
            <div className="overflow-hidden rounded-2xl border border-stroke bg-elev">
              {bucket.events.map((e, i) => (
                <div
                  key={e.id}
                  className={cn(
                    "flex items-center gap-3 px-3.5 py-2.5",
                    (i > 0 || false) && "border-t border-stroke",
                  )}
                >
                  <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", WHO_DOT[e.who])} />
                  <span className="w-[74px] shrink-0 text-[12.5px] tabular-nums text-muted">
                    {e.allDay ? "all day" : timeLabel(e.start)}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{e.title}</span>
                </div>
              ))}
              {bucket.tasks.map((t, i) => (
                <div
                  key={t.id}
                  className={cn(
                    "flex items-center gap-3 px-3.5 py-2.5",
                    (bucket.events.length > 0 || i > 0) && "border-t border-stroke",
                  )}
                >
                  <span className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border-2 border-stroke-strong" />
                  <span className="w-[74px] shrink-0 text-[12.5px] tabular-nums text-muted">
                    {t.allDay ? "task" : timeLabel(t.dueAt!)}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[14px] text-ink",
                      t.status === "done" && "line-through opacity-60",
                    )}
                  >
                    {t.title}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
