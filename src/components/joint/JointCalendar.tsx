"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/api";
import type { CalendarEvent, Task } from "@/lib/types";
import { hueSoftVar, hueVar, normalizeJointColor, type JointColorId } from "@/lib/jointColors";
import { dayHeading, timeLabel } from "@/lib/format";
import { addDaysToDateKey, cn } from "@/lib/utils";
import { useIsWideScreen } from "@/hooks/useMediaQuery";
import { Segmented } from "@/components/ui/Segmented";
import { Sheet } from "@/components/ui/Sheet";
import { SkeletonRows } from "@/components/ui/Misc";
import { IconChevronLeft, IconChevronRight } from "@/components/ui/icons";

interface Entry extends CalendarEvent {
  who: "owner" | "partner";
}

interface Payload {
  events: Entry[];
  tasks: Task[];
  warnings: string[];
  from: string;
}

/** Each person's resolved color, defaults blue (owner) / pink (partner). */
interface WhoColors {
  owner: JointColorId;
  partner: JointColorId;
}

const dotStyle = (c: JointColorId): CSSProperties => ({ background: hueVar(c) });
const blockColors = (c: JointColorId): CSSProperties => ({
  background: hueSoftVar(c),
  borderColor: hueVar(c),
});

export type CalendarMode = "agenda" | "week" | "month";

// ── Dates ──────────────────────────────────────────────────────────────────
// Local time throughout, keyed YYYY-MM-DD so a range survives the round trip
// to the server (which resolves it against the account's timezone).

function keyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayKeyOf(iso: string): string {
  return keyOf(new Date(iso));
}

function dateOf(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function startOfWeek(key: string): string {
  const d = dateOf(key);
  return keyOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()));
}

/** First cell of a month grid: the Sunday on or before the 1st. */
function startOfMonthGrid(key: string): string {
  const d = dateOf(key);
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  return keyOf(new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay()));
}

/** The window a mode shows. */
function rangeFor(mode: CalendarMode, anchor: string): { from: string; days: number } {
  if (mode === "week") return { from: startOfWeek(anchor), days: 7 };
  if (mode === "month") return { from: startOfMonthGrid(anchor), days: 42 };
  return { from: anchor, days: 7 };
}

/** How the arrows step: a month at a time in month view, a week otherwise. */
function stepAnchor(mode: CalendarMode, anchor: string, dir: 1 | -1): string {
  if (mode === "month") {
    const d = dateOf(anchor);
    return keyOf(new Date(d.getFullYear(), d.getMonth() + dir, 1));
  }
  return addDaysToDateKey(anchor, dir * 7);
}

function rangeLabel(mode: CalendarMode, anchor: string): string {
  if (mode === "month") {
    return dateOf(anchor).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }
  const { from, days } = rangeFor(mode, anchor);
  const start = dateOf(from);
  const end = dateOf(addDaysToDateKey(from, days - 1));
  const sameMonth = start.getMonth() === end.getMonth();
  const startText = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const endText = end.toLocaleDateString("en-US", {
    month: sameMonth ? undefined : "short",
    day: "numeric",
  });
  return `${startText} – ${endText}, ${end.getFullYear()}`;
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

interface Selected {
  title: string;
  who: Entry["who"];
  when: string;
  location: string | null;
}

/**
 * The couple calendar: an agenda list, a week grid, or a month grid, over a
 * window you can walk forwards and back. `mode` is owned by the page so a
 * desktop can hand the grid the whole width.
 */
export function JointCalendar({
  names,
  colors,
  mode,
  onModeChange,
}: {
  names: { owner: string; partner: string };
  colors?: { owner?: string; partner?: string };
  mode: CalendarMode;
  onModeChange: (m: CalendarMode) => void;
}) {
  const who: WhoColors = {
    owner: normalizeJointColor(colors?.owner, "blue"),
    partner: normalizeJointColor(colors?.partner, "pink"),
  };

  const [today, setToday] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);

  // Resolved after mount so server and first client render agree.
  useEffect(() => {
    const key = keyOf(new Date());
    setToday(key);
    setAnchor((a) => a ?? key);
  }, []);

  const { from, days } = rangeFor(mode, anchor ?? "1970-01-01");
  const { data, isLoading } = useSWR<Payload>(
    anchor ? `/api/joint/calendar?from=${from}&days=${days}` : null,
    fetcher,
    { refreshInterval: 5 * 60_000, keepPreviousData: true },
  );

  const whoName = (w: Entry["who"]) => (w === "partner" ? names.partner : names.owner);
  const atToday = !!today && !!anchor && rangeFor(mode, anchor).from === rangeFor(mode, today).from;

  const openDayInWeek = (key: string) => {
    setAnchor(key);
    onModeChange("week");
  };

  return (
    <div className="space-y-3">
      <Toolbar
        names={names}
        colors={who}
        mode={mode}
        onModeChange={onModeChange}
        label={anchor ? rangeLabel(mode, anchor) : ""}
        atToday={atToday}
        onStep={(dir) => setAnchor((a) => (a ? stepAnchor(mode, a, dir) : a))}
        onToday={() => setAnchor(today)}
      />

      {(data?.warnings ?? []).map((w) => (
        <p key={w} className="rounded-2xl border border-stroke bg-sunken px-3.5 py-2.5 text-[13px] text-warn">
          {w}
        </p>
      ))}

      {isLoading && !data ? (
        <SkeletonRows rows={4} />
      ) : mode === "week" ? (
        <WeekGrid data={data} from={from} today={today} onPick={setSelected} whoName={whoName} colors={who} />
      ) : mode === "month" ? (
        <MonthGrid
          data={data}
          from={from}
          anchor={anchor}
          today={today}
          onPick={setSelected}
          onOpenDay={openDayInWeek}
          colors={who}
        />
      ) : (
        <Agenda data={data} colors={who} />
      )}

      <Sheet open={!!selected} onClose={() => setSelected(null)} title={selected?.title ?? ""}>
        {selected ? (
          <div className="space-y-2 pb-2 text-[14px] text-ink">
            <p className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full" style={dotStyle(who[selected.who])} />
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

// ── Toolbar ────────────────────────────────────────────────────────────────

function Toolbar({
  names,
  colors,
  mode,
  onModeChange,
  label,
  atToday,
  onStep,
  onToday,
}: {
  names: { owner: string; partner: string };
  colors: WhoColors;
  mode: CalendarMode;
  onModeChange: (m: CalendarMode) => void;
  label: string;
  atToday: boolean;
  onStep: (dir: 1 | -1) => void;
  onToday: () => void;
}) {
  const step = mode === "month" ? "month" : "week";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <button
        type="button"
        onClick={onToday}
        disabled={atToday}
        className="min-h-[34px] rounded-full border border-stroke px-3 text-[13px] font-medium text-ink transition-colors hover:bg-sunken disabled:opacity-40"
      >
        Today
      </button>
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => onStep(-1)}
          aria-label={`Previous ${step}`}
          className="grid h-9 w-9 place-items-center rounded-full text-muted transition-colors hover:bg-sunken hover:text-ink"
        >
          <IconChevronLeft className="h-[18px] w-[18px]" />
        </button>
        <button
          type="button"
          onClick={() => onStep(1)}
          aria-label={`Next ${step}`}
          className="grid h-9 w-9 place-items-center rounded-full text-muted transition-colors hover:bg-sunken hover:text-ink"
        >
          <IconChevronRight className="h-[18px] w-[18px]" />
        </button>
      </div>

      <p className="order-last w-full truncate text-[15px] font-semibold tracking-tight text-ink sm:order-none sm:w-auto sm:flex-1">
        {label}
      </p>

      <div className="flex items-center gap-3 text-[12px] text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={dotStyle(colors.owner)} /> {names.owner}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={dotStyle(colors.partner)} /> {names.partner}
        </span>
      </div>

      <Segmented
        size="sm"
        ariaLabel="Calendar style"
        className="w-auto min-w-[210px] max-w-[280px]"
        value={mode}
        onChange={onModeChange}
        options={[
          { value: "agenda" as const, label: "Agenda" },
          { value: "week" as const, label: "Week" },
          { value: "month" as const, label: "Month" },
        ]}
      />
    </div>
  );
}

// ── Agenda ─────────────────────────────────────────────────────────────────

function Agenda({ data, colors }: { data: Payload | undefined; colors: WhoColors }) {
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
        Nothing on either calendar in this stretch. Use the arrows to look further ahead, or add
        feeds in Settings → Shared list.
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
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={dotStyle(colors[e.who])} />
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

// ── Week grid ──────────────────────────────────────────────────────────────

// Phone-sized rows look lost in a desktop column; both scales run the same
// maths, chosen once per breakpoint.
const HOUR_PX_PHONE = 44;
const HOUR_PX_WIDE = 58;
const GUTTER_PX_PHONE = 44;
const GUTTER_PX_WIDE = 60;

function WeekGrid({
  data,
  from,
  today,
  onPick,
  whoName,
  colors,
}: {
  data: Payload | undefined;
  from: string;
  today: string | null;
  onPick: (s: Selected) => void;
  whoName: (w: Entry["who"]) => string;
  colors: WhoColors;
}) {
  const wide = useIsWideScreen();
  const hourPx = wide ? HOUR_PX_WIDE : HOUR_PX_PHONE;
  const gutterPx = wide ? GUTTER_PX_WIDE : GUTTER_PX_PHONE;
  const scroller = useRef<HTMLDivElement>(null);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysToDateKey(from, i)), [from]);

  const { timed, allDay } = useMemo(() => {
    const timedOut: Entry[] = [];
    const allDayOut: Entry[] = [];
    for (const e of data?.events ?? []) (e.allDay ? allDayOut : timedOut).push(e);
    return { timed: timedOut, allDay: allDayOut };
  }, [data]);

  // The whole day is drawn and the grid scrolls, like every desktop calendar —
  // but it opens where the day actually starts rather than at midnight.
  const firstHour = useMemo(() => {
    let h = 8;
    for (const e of timed) h = Math.min(h, new Date(e.start).getHours());
    return Math.max(0, h - 1);
  }, [timed]);

  useEffect(() => {
    // a few pixels of slack so the first hour label clears the sticky header
    if (scroller.current) scroller.current.scrollTop = Math.max(0, firstHour * hourPx - 10);
  }, [firstHour, hourPx, from]);

  const hours = Array.from({ length: 24 }, (_, i) => i);
  const cols = { gridTemplateColumns: `${gutterPx}px repeat(7, minmax(0, 1fr))` };
  const hasAllDay = allDay.length + (data?.tasks.length ?? 0) > 0;

  return (
    <div
      ref={scroller}
      className="relative h-[68dvh] overflow-y-auto overscroll-contain rounded-2xl border border-stroke bg-elev xl:h-[calc(100dvh-232px)]"
    >
      {/* Day names and the all-day lane ride along while the hours scroll */}
      <div className="sticky top-0 z-20 border-b border-stroke bg-elev">
        <div className="grid" style={cols}>
          <span />
          {days.map((key) => {
            const d = dateOf(key);
            return (
              <div key={key} className="flex flex-col items-center gap-0.5 border-l border-stroke py-2">
                <span className="text-[10px] uppercase tracking-wide text-faint">
                  {d.toLocaleDateString("en-US", { weekday: "short" })}
                </span>
                <span
                  className={cn(
                    "grid place-items-center rounded-full font-medium",
                    wide ? "h-8 w-8 text-[15px]" : "h-6 w-6 text-[12.5px]",
                    key === today ? "bg-sunrise text-on-accent" : "text-ink",
                  )}
                >
                  {d.getDate()}
                </span>
              </div>
            );
          })}
        </div>

        {hasAllDay ? (
          <div className="grid border-t border-stroke" style={cols}>
            <span className="py-1 pr-1 text-right text-[9px] uppercase text-faint">all day</span>
            {days.map((key) => {
              const chips = allDay.filter((e) => dayKeyOf(e.start) === key);
              const dayTasks = (data?.tasks ?? []).filter((t) => t.dueAt && dayKeyOf(t.dueAt) === key);
              return (
                <div key={key} className="min-h-[24px] space-y-0.5 border-l border-stroke p-0.5">
                  {chips.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => onPick({ title: e.title, who: e.who, when: "All day", location: e.location })}
                      className={cn(
                        "block w-full truncate rounded border-l-2 px-1 py-0.5 text-left leading-tight text-ink",
                        wide ? "text-[11.5px]" : "text-[9.5px]",
                      )}
                      style={blockColors(colors[e.who])}
                    >
                      {e.title}
                    </button>
                  ))}
                  {dayTasks.map((t) => (
                    <span
                      key={t.id}
                      title={t.title}
                      className={cn(
                        "block w-full truncate rounded border-l-2 border-stroke-strong bg-sunken px-1 py-0.5 leading-tight text-muted",
                        wide ? "text-[11.5px]" : "text-[9.5px]",
                        t.status === "done" && "line-through opacity-60",
                      )}
                    >
                      ✓ {t.title}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        ) : null}
      </div>

      {/* Timed grid: the full day, scrolled into view */}
      <div className="relative grid" style={{ ...cols, height: 24 * hourPx }}>
        <div className="relative">
          {hours.map((h, i) => (
            <span
              key={h}
              className={cn(
                "absolute right-1.5 -translate-y-1/2 tabular-nums text-faint",
                wide ? "text-[11px]" : "text-[9.5px]",
              )}
              style={{ top: i * hourPx }}
            >
              {i === 0 ? "" : `${h % 12 === 0 ? 12 : h % 12}${h >= 12 ? "p" : "a"}`}
            </span>
          ))}
        </div>
        {days.map((key) => {
          const dayEvents = timed.filter((e) => dayKeyOf(e.start) === key);
          const lanes = layoutLanes(dayEvents);
          return (
            <div key={key} className="relative border-l border-stroke">
              {hours.map((h, i) =>
                i > 0 ? (
                  <span
                    key={h}
                    className="absolute inset-x-0 border-t border-stroke opacity-60"
                    style={{ top: i * hourPx }}
                  />
                ) : null,
              )}
              {key === today ? <NowLine hourPx={hourPx} /> : null}
              {dayEvents.map((e) => {
                const s = new Date(e.start);
                const en = new Date(e.end);
                const startH = s.getHours() + s.getMinutes() / 60;
                const endH = en.getHours() + en.getMinutes() / 60 || startH + 1;
                const height = Math.max(22, (Math.max(endH, startH + 0.4) - startH) * hourPx - 2);
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
                      "absolute overflow-hidden rounded-md border-l-2 px-1.5 py-1 text-left leading-tight text-ink",
                      wide ? "text-[11.5px]" : "text-[9.5px]",
                    )}
                    style={{
                      top: startH * hourPx,
                      height,
                      left: `calc(${slot.lane * width}% + 2px)`,
                      width: `calc(${width}% - 4px)`,
                      ...blockColors(colors[e.who]),
                    }}
                    title={`${e.title} · ${whoName(e.who)}`}
                  >
                    <span className="line-clamp-3 font-medium">{e.title}</span>
                    {height > 44 ? (
                      <span className="block truncate opacity-70">{timeLabel(e.start)}</span>
                    ) : null}
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

function NowLine({ hourPx }: { hourPx: number }) {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  if (!now) return null;
  const h = now.getHours() + now.getMinutes() / 60;
  return (
    <span
      className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger"
      style={{ top: h * hourPx }}
    />
  );
}

// ── Month grid ─────────────────────────────────────────────────────────────

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function MonthGrid({
  data,
  from,
  anchor,
  today,
  onPick,
  onOpenDay,
  colors,
}: {
  data: Payload | undefined;
  from: string;
  anchor: string | null;
  today: string | null;
  onPick: (s: Selected) => void;
  onOpenDay: (key: string) => void;
  colors: WhoColors;
}) {
  const wide = useIsWideScreen();
  const cells = useMemo(() => Array.from({ length: 42 }, (_, i) => addDaysToDateKey(from, i)), [from]);
  const shownMonth = dateOf(anchor ?? from).getMonth();
  const perDay = wide ? 4 : 2;

  const byDay = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const e of data?.events ?? []) {
      const key = dayKeyOf(e.start);
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    for (const list of map.values()) list.sort((a, b) => a.start.localeCompare(b.start));
    return map;
  }, [data]);

  const tasksByDay = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const t of data?.tasks ?? []) {
      if (!t.dueAt) continue;
      const key = dayKeyOf(t.dueAt);
      map.set(key, [...(map.get(key) ?? []), t]);
    }
    return map;
  }, [data]);

  return (
    <div className="overflow-hidden rounded-2xl border border-stroke bg-elev">
      <div className="grid grid-cols-7 border-b border-stroke">
        {WEEKDAYS.map((d) => (
          <span key={d} className="py-2 text-center text-[10px] uppercase tracking-wide text-faint">
            {wide ? d : d[0]}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((key, i) => {
          const d = dateOf(key);
          const events = byDay.get(key) ?? [];
          const tasks = tasksByDay.get(key) ?? [];
          const items = events.length + tasks.length;
          const outside = d.getMonth() !== shownMonth;
          return (
            <div
              key={key}
              className={cn(
                "min-h-[86px] border-stroke p-1 xl:min-h-[112px]",
                i % 7 !== 0 && "border-l",
                i >= 7 && "border-t",
                outside && "bg-sunken/60",
              )}
            >
              <button
                type="button"
                onClick={() => onOpenDay(key)}
                aria-label={`Open the week of ${key}`}
                className={cn(
                  "mb-0.5 grid h-6 w-6 place-items-center rounded-full text-[12px] font-medium transition-colors",
                  key === today
                    ? "bg-sunrise text-on-accent"
                    : outside
                      ? "text-faint hover:bg-sunken"
                      : "text-ink hover:bg-sunken",
                )}
              >
                {d.getDate()}
              </button>
              <div className="space-y-0.5">
                {events.slice(0, perDay).map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() =>
                      onPick({
                        title: e.title,
                        who: e.who,
                        when: e.allDay ? "All day" : `${timeLabel(e.start)} – ${timeLabel(e.end)}`,
                        location: e.location,
                      })
                    }
                    className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-[10.5px] leading-tight text-ink transition-colors hover:bg-sunken xl:text-[11.5px]"
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={dotStyle(colors[e.who])} />
                    {!e.allDay ? (
                      <span className="shrink-0 tabular-nums text-muted">{timeLabel(e.start)}</span>
                    ) : null}
                    <span className="min-w-0 flex-1 truncate">{e.title}</span>
                  </button>
                ))}
                {tasks.slice(0, Math.max(0, perDay - events.length)).map((t) => (
                  <span
                    key={t.id}
                    title={t.title}
                    className={cn(
                      "flex w-full items-center gap-1 rounded px-1 py-0.5 text-[10.5px] leading-tight text-muted xl:text-[11.5px]",
                      t.status === "done" && "line-through opacity-60",
                    )}
                  >
                    ✓ <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  </span>
                ))}
                {items > perDay ? (
                  <button
                    type="button"
                    onClick={() => onOpenDay(key)}
                    className="px-1 text-[10.5px] font-medium text-accent hover:underline"
                  >
                    +{items - perDay} more
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
