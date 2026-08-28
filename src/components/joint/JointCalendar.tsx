"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import type { CalendarEvent, Task } from "@/lib/types";
import { dayHeading, timeLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Segmented } from "@/components/ui/Segmented";
import { Sheet } from "@/components/ui/Sheet";
import { SkeletonRows } from "@/components/ui/Misc";

interface Entry extends CalendarEvent {
  who: "owner" | "partner";
}

interface Payload {
  events: Entry[];
  tasks: Task[];
  warnings: string[];
  from: string;
}

// Two clearly different hues: warm orange = owner, cool blue = partner.
const WHO_DOT: Record<Entry["who"], string> = {
  owner: "bg-accent",
  partner: "bg-partner",
};
const WHO_BLOCK: Record<Entry["who"], string> = {
  owner: "bg-accent-soft border-accent text-ink",
  partner: "bg-partner-soft border-partner text-ink",
};

type Mode = "agenda" | "week";
const MODE_KEY = "donex.jointCal.mode";

function loadMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === "week" ? "week" : "agenda";
  } catch {
    return "agenda";
  }
}

/** Google-Calendar-style lanes: overlapping events share the column width. */
function layoutLanes(events: Entry[]): Map<string, { lane: number; lanes: number }> {
  const sorted = [...events].sort((a, b) => a.start.localeCompare(b.start));
  const result = new Map<string, { lane: number; lanes: number }>();
  let cluster: Entry[] = [];
  let clusterEnd = "";
  const flush = () => {
    if (cluster.length === 0) return;
    const laneEnds: string[] = [];
    const laneOf = new Map<string, number>();
    for (const e of cluster) {
      let lane = laneEnds.findIndex((end) => end <= e.start);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(e.end);
      } else {
        laneEnds[lane] = e.end;
      }
      laneOf.set(e.id, lane);
    }
    for (const e of cluster) {
      result.set(e.id, { lane: laneOf.get(e.id) ?? 0, lanes: laneEnds.length });
    }
    cluster = [];
    clusterEnd = "";
  };
  for (const e of sorted) {
    if (cluster.length > 0 && e.start >= clusterEnd) flush();
    cluster.push(e);
    if (e.end > clusterEnd) clusterEnd = e.end;
  }
  flush();
  return result;
}

function dayKeyOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface Selected {
  title: string;
  who: Entry["who"];
  when: string;
  location: string | null;
}

/** The couple calendar: an agenda list, or a Google-Calendar-style week grid. */
export function JointCalendar({ names }: { names: { owner: string; partner: string } }) {
  const { data, isLoading } = useSWR<Payload>("/api/joint/calendar?days=7", fetcher, {
    refreshInterval: 5 * 60_000,
  });
  const [mode, setMode] = useState<Mode>("agenda");
  const [selected, setSelected] = useState<Selected | null>(null);

  useEffect(() => setMode(loadMode()), []);
  const pickMode = (m: Mode) => {
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* per-device convenience only */
    }
  };

  const whoName = (who: Entry["who"]) => (who === "partner" ? names.partner : names.owner);

  if (isLoading) return <SkeletonRows rows={4} />;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-4 px-1 text-[12px] text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className={cn("h-2.5 w-2.5 rounded-full", WHO_DOT.owner)} /> {names.owner}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className={cn("h-2.5 w-2.5 rounded-full", WHO_DOT.partner)} /> {names.partner}
          </span>
        </div>
        <Segmented
          size="sm"
          ariaLabel="Calendar style"
          className="w-auto min-w-[150px]"
          value={mode}
          onChange={pickMode}
          options={[
            { value: "agenda" as const, label: "Agenda" },
            { value: "week" as const, label: "Week" },
          ]}
        />
      </div>

      {(data?.warnings ?? []).map((w) => (
        <p key={w} className="rounded-2xl border border-stroke bg-sunken px-3.5 py-2.5 text-[13px] text-warn">
          {w}
        </p>
      ))}

      {mode === "week" ? (
        <WeekGrid data={data} onPick={setSelected} whoName={whoName} />
      ) : (
        <Agenda data={data} />
      )}

      <Sheet
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.title ?? ""}
      >
        {selected ? (
          <div className="space-y-2 pb-2 text-[14px] text-ink">
            <p className="flex items-center gap-2">
              <span className={cn("h-2.5 w-2.5 rounded-full", WHO_DOT[selected.who])} />
              {whoName(selected.who)}
            </p>
            <p className="text-muted">{selected.when}</p>
            {selected.location ? <p className="text-muted">📍 {selected.location}</p> : null}
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}

// ── Agenda (the original list) ─────────────────────────────────────────────

function Agenda({ data }: { data: Payload | undefined }) {
  const byDay = useMemo(() => {
    const map = new Map<string, { events: Entry[]; tasks: Task[] }>();
    for (const e of data?.events ?? []) {
      const key = dayKeyOf(e.start);
      const bucket = map.get(key) ?? { events: [], tasks: [] };
      bucket.events.push(e);
      map.set(key, bucket);
    }
    for (const t of data?.tasks ?? []) {
      if (!t.dueAt) continue;
      const key = dayKeyOf(t.dueAt);
      const bucket = map.get(key) ?? { events: [], tasks: [] };
      bucket.tasks.push(t);
      map.set(key, bucket);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data]);

  if (byDay.length === 0) {
    return (
      <p className="rounded-2xl border border-stroke bg-elev px-4 py-6 text-center text-[14px] text-muted">
        Nothing on either calendar this week. Add feeds in Settings → Shared list.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {byDay.map(([key, bucket]) => (
        <section key={key}>
          <p className="mb-1.5 px-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">
            {dayHeading(key)}
          </p>
          <div className="overflow-hidden rounded-2xl border border-stroke bg-elev">
            {bucket.events.map((e, i) => (
              <div
                key={e.id}
                className={cn("flex items-center gap-3 px-3.5 py-2.5", i > 0 && "border-t border-stroke")}
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
      ))}
    </div>
  );
}

// ── Week grid (the visual view) ────────────────────────────────────────────

const HOUR_PX = 44;
const GUTTER_PX = 44;

function WeekGrid({
  data,
  onPick,
  whoName,
}: {
  data: Payload | undefined;
  onPick: (s: Selected) => void;
  whoName: (w: Entry["who"]) => string;
}) {
  const days = useMemo(() => {
    const start = data?.from ? new Date(data.from) : new Date();
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
  }, [data]);

  const { timed, allDay, hourFrom, hourTo } = useMemo(() => {
    const timed: Entry[] = [];
    const allDay: Entry[] = [];
    for (const e of data?.events ?? []) (e.allDay ? allDay : timed).push(e);
    // Dated joint tasks ride the grid as short blocks owned by no one colour —
    // render them neutral in the all-day lane when undated-in-day.
    let lo = 8;
    let hi = 21;
    for (const e of timed) {
      lo = Math.min(lo, new Date(e.start).getHours());
      hi = Math.max(hi, new Date(e.end).getHours() + 1);
    }
    return { timed, allDay, hourFrom: Math.max(0, lo), hourTo: Math.min(24, Math.max(hi, lo + 6)) };
  }, [data]);

  const todayKey = dayKeyOf(new Date().toISOString());
  const hours = Array.from({ length: hourTo - hourFrom }, (_, i) => hourFrom + i);
  const gridHeight = hours.length * HOUR_PX;

  const columnOf = (iso: string): number =>
    days.findIndex((d) => dayKeyOf(d.toISOString()) === dayKeyOf(iso));

  const blockStyle = (e: Entry): { top: number; height: number } => {
    const s = new Date(e.start);
    const en = new Date(e.end);
    const startH = s.getHours() + s.getMinutes() / 60;
    const endH = en.getHours() + en.getMinutes() / 60 || startH + 1;
    const top = Math.max(0, (startH - hourFrom) * HOUR_PX);
    const height = Math.max(22, (Math.max(endH, startH + 0.4) - Math.max(startH, hourFrom)) * HOUR_PX - 2);
    return { top, height };
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-stroke bg-elev">
      {/* Day headers */}
      <div className="grid border-b border-stroke" style={{ gridTemplateColumns: `${GUTTER_PX}px repeat(7, 1fr)` }}>
        <span />
        {days.map((d) => {
          const key = dayKeyOf(d.toISOString());
          const isToday = key === todayKey;
          return (
            <div key={key} className="flex flex-col items-center gap-0.5 py-2">
              <span className="text-[10px] uppercase tracking-wide text-faint">
                {d.toLocaleDateString("en-US", { weekday: "short" })}
              </span>
              <span
                className={cn(
                  "grid h-6 w-6 place-items-center rounded-full text-[12.5px] font-medium",
                  isToday ? "bg-sunrise text-on-accent" : "text-ink",
                )}
              >
                {d.getDate()}
              </span>
            </div>
          );
        })}
      </div>

      {/* All-day / task chips lane */}
      {allDay.length + (data?.tasks.length ?? 0) > 0 ? (
        <div
          className="grid border-b border-stroke"
          style={{ gridTemplateColumns: `${GUTTER_PX}px repeat(7, 1fr)` }}
        >
          <span className="py-1 pr-1 text-right text-[9px] uppercase text-faint">all day</span>
          {days.map((d) => {
            const key = dayKeyOf(d.toISOString());
            const chips = [
              ...allDay.filter((e) => dayKeyOf(e.start) === key),
            ];
            const dayTasks = (data?.tasks ?? []).filter((t) => t.dueAt && dayKeyOf(t.dueAt) === key);
            return (
              <div key={key} className="min-h-[22px] space-y-0.5 border-l border-stroke p-0.5">
                {chips.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => onPick({ title: e.title, who: e.who, when: "All day", location: e.location })}
                    className={cn(
                      "block w-full truncate rounded border-l-2 px-1 py-0.5 text-left text-[9.5px] leading-tight",
                      WHO_BLOCK[e.who],
                    )}
                  >
                    {e.title}
                  </button>
                ))}
                {dayTasks.map((t) => (
                  <span
                    key={t.id}
                    className={cn(
                      "block w-full truncate rounded border-l-2 border-stroke-strong bg-sunken px-1 py-0.5 text-[9.5px] leading-tight text-muted",
                      t.status === "done" && "line-through opacity-60",
                    )}
                    title={t.title}
                  >
                    ✓ {t.title}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Timed grid */}
      <div className="relative grid" style={{ gridTemplateColumns: `${GUTTER_PX}px repeat(7, 1fr)`, height: gridHeight }}>
        {/* hour gutter + lines */}
        <div className="relative">
          {hours.map((h, i) => (
            <span
              key={h}
              className="absolute right-1 -translate-y-1/2 text-[9.5px] tabular-nums text-faint"
              style={{ top: i * HOUR_PX }}
            >
              {i === 0 ? "" : h % 12 === 0 ? 12 : h % 12}
              {i === 0 ? "" : h >= 12 ? "p" : "a"}
            </span>
          ))}
        </div>
        {days.map((d, col) => {
          const key = dayKeyOf(d.toISOString());
          const dayEvents = timed.filter((e) => columnOf(e.start) === col);
          const lanes = layoutLanes(dayEvents);
          return (
            <div key={key} className="relative border-l border-stroke">
              {hours.map((h, i) =>
                i > 0 ? (
                  <span
                    key={h}
                    className="absolute inset-x-0 border-t border-stroke opacity-60"
                    style={{ top: i * HOUR_PX }}
                  />
                ) : null,
              )}
              {key === todayKey ? <NowLine hourFrom={hourFrom} hourTo={hourTo} /> : null}
              {dayEvents.map((e) => {
                const { top, height } = blockStyle(e);
                const slot = lanes.get(e.id) ?? { lane: 0, lanes: 1 };
                const width = 100 / slot.lanes;
                return (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() =>
                      onPick({
                        title: e.title,
                        who: e.who,
                        when: `${timeLabel(e.start)} – ${timeLabel(e.end)}`,
                        location: e.location,
                      })
                    }
                    className={cn(
                      "absolute overflow-hidden rounded-md border-l-2 px-1 py-0.5 text-left text-[9.5px] leading-tight",
                      WHO_BLOCK[e.who],
                    )}
                    style={{
                      top,
                      height,
                      left: `calc(${slot.lane * width}% + 2px)`,
                      width: `calc(${width}% - 4px)`,
                    }}
                    title={`${e.title} · ${whoName(e.who)}`}
                  >
                    <span className="line-clamp-3 font-medium">{e.title}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NowLine({ hourFrom, hourTo }: { hourFrom: number; hourTo: number }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const h = now.getHours() + now.getMinutes() / 60;
  if (h < hourFrom || h > hourTo) return null;
  return (
    <span
      className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger"
      style={{ top: (h - hourFrom) * HOUR_PX }}
    />
  );
}
