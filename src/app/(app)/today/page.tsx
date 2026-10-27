"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { fetcher, keys } from "@/lib/api";
import type { Project, StatsSummary, Task } from "@/lib/types";
import { greeting, isOverdue, longDateLine } from "@/lib/format";
import { useDisplayTimeZone } from "@/hooks/useDisplayTimeZone";
import { isUrgent } from "@/lib/deadline";
import { rotatingSample, rotationSlot } from "@/lib/rotate";
import { Page } from "@/components/shell/Page";
import { Button } from "@/components/ui/Button";
import { EmptyState, SkeletonRows } from "@/components/ui/Misc";
import { IconPlus, IconRefresh } from "@/components/ui/icons";
import { TaskEditor } from "@/components/tasks/TaskEditor";
import { TaskGroup, TaskList } from "@/components/tasks/TaskList";
import { QuickAddSheet } from "@/components/tasks/QuickAdd";
import { BriefingCard } from "@/components/today/BriefingCard";
import { CalendarStrip } from "@/components/today/CalendarStrip";
import { TripCard } from "@/components/today/TripCard";

const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
/** The due-time wake-up below never fires more often than this. */
const MIN_WAKE_MS = 30_000;

export default function TodayPage() {
  const { data, error, isLoading, mutate } = useSWR<{ tasks: Task[] }>(
    keys.tasks({ view: "today", includeDone: true }),
    fetcher,
  );
  const {
    data: anytimeData,
    error: anytimeError,
    mutate: mutateAnytime,
  } = useSWR<{ tasks: Task[] }>(
    keys.tasks({ view: "anytime", excludeProjects: true }),
    fetcher,
  );
  const { data: projectData } = useSWR<{ projects: Project[] }>(keys.projects(), fetcher);
  const { data: stats } = useSWR<StatsSummary>(keys.stats(), fetcher);

  const [editing, setEditing] = useState<Task | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [now, setNow] = useState<Date | null>(null);
  const [slot, setSlot] = useState(() => rotationSlot());
  const lastWake = useRef(0);

  useEffect(() => setNow(new Date()), []);

  // Advance the Anytime rotation while the app sits open on the home screen,
  // and keep the clock with it: the greeting, the date line, the briefing
  // order and which project tasks count as urgent all read `now`. Within the
  // same hour the old Date is kept, so a tick doesn't re-render the list; a
  // timed task falling due moves it separately, below.
  useEffect(() => {
    const tick = () => {
      setSlot(rotationSlot());
      setNow((prev) => {
        const next = new Date();
        return prev &&
          prev.getHours() === next.getHours() &&
          prev.toDateString() === next.toDateString()
          ? prev
          : next;
      });
    };
    const id = window.setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, []);

  const projects = projectData?.projects ?? [];
  // Project work lives on the Projects tab — except when it's about to bite:
  // overdue, due today, or a deadline landing by tomorrow.
  // All-day dates are read in the app's zone once it is known; re-group then.
  const displayTz = useDisplayTimeZone();
  const all = useMemo(
    () =>
      (data?.tasks ?? []).filter(
        (t) =>
          !t.parentId && (!t.projectId || isUrgent(t, displayTz ?? deviceTz, now ?? undefined)),
      ),
    [data, now, displayTz],
  );

  // The Overdue/Today split reads the live clock but only recomputes with
  // `now`, which otherwise moves on the hour. Wake once when the next open
  // timed task falls due, so it changes groups on time.
  useEffect(() => {
    const at = Date.now();
    let nextDue = Infinity;
    for (const t of all) {
      if (t.status === "done" || t.allDay || !t.dueAt) continue;
      const due = Date.parse(t.dueAt);
      if (due > at && due < nextDue) nextDue = due;
    }
    // Later than a day out, the hourly tick re-arms this before it matters.
    if (!Number.isFinite(nextDue) || nextDue - at > 86_400_000) return;
    const delay = Math.max(nextDue - at + 50, lastWake.current + MIN_WAKE_MS - at);
    const id = window.setTimeout(() => {
      lastWake.current = Date.now();
      setNow(new Date());
    }, delay);
    return () => window.clearTimeout(id);
  }, [all]);

  const { overdue, today, done } = useMemo(() => {
    const o: Task[] = [];
    const t: Task[] = [];
    const d: Task[] = [];
    for (const task of all) {
      if (task.status === "done") d.push(task);
      else if (isOverdue(task.dueAt, task.allDay)) o.push(task);
      else t.push(task);
    }
    return { overdue: o, today: t, done: d };
  }, [all, displayTz]);

  const anytime = useMemo(
    () =>
      (anytimeData?.tasks ?? []).filter((t) => !t.parentId && t.status !== "done"),
    [anytimeData],
  );
  // A different handful every few hours, steady in between.
  const anytimeShown = useMemo(() => rotatingSample(anytime, 8, slot), [anytime, slot]);

  const streak = stats?.streakDays ?? 0;
  const empty = !isLoading && overdue.length === 0 && today.length === 0;
  // A failed load is not an empty day. A failed Anytime list alone only
  // matters when it would otherwise read as "Nothing on today".
  const failed =
    (!!error && !data) || (!!anytimeError && !anytimeData && empty && done.length === 0);

  // The top of the page belongs to whatever is useful right now: the briefing
  // and the plan lead in the morning, then step aside for the list itself.
  // Rendered only once the clock is known, so nothing jumps after hydration.
  const leadWith = now !== null && now.getHours() < 12;

  return (
    <Page
      aside={now ? <BriefingCard tasks={all} onFocusTask={setEditing} /> : null}
      asideLeads={leadWith}
    >
      <header className="mb-5 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            {now ? greeting(now) : "Hello"}
          </h1>
          <p className="mt-1 text-[14px] text-muted">{now ? longDateLine(now) : " "}</p>
        </div>
        {streak >= 2 ? (
          <span className="mt-1 shrink-0 rounded-full bg-accent-soft px-3 py-1.5 text-[13px] font-medium text-accent">
            🔥 {streak}
          </span>
        ) : null}
      </header>

      <div className="mb-6">
        <TripCard />
        <CalendarStrip />
      </div>

      {isLoading ? (
        <SkeletonRows rows={4} />
      ) : failed ? (
        <EmptyState
          emoji="📡"
          title="Could not load your tasks"
          message="Check your connection and try again."
          action={
            <Button
              icon={<IconRefresh className="h-4 w-4" />}
              onClick={() => {
                void mutate();
                void mutateAnytime();
              }}
            >
              Try again
            </Button>
          }
        />
      ) : empty && done.length === 0 && anytime.length === 0 ? (
        <EmptyState
          emoji="🌤️"
          title="Nothing on today"
          message="A clear day. Add something small, or just enjoy it."
          action={
            <Button variant="primary" icon={<IconPlus className="h-4 w-4" />} onClick={() => setQuickOpen(true)}>
              Add a task
            </Button>
          }
        />
      ) : (
        <>
          {overdue.length ? (
            <TaskGroup title="Overdue" count={overdue.length} tone="danger">
              <TaskList tasks={overdue} projects={projects} onOpen={setEditing} />
            </TaskGroup>
          ) : null}

          {today.length ? (
            <TaskGroup title="Today" count={today.length}>
              <TaskList tasks={today} projects={projects} onOpen={setEditing} />
            </TaskGroup>
          ) : null}

          {empty && done.length ? (
            <div className="mb-6 rounded-2xl border border-stroke bg-elev px-4 py-6 text-center">
              <p className="text-[15px] font-medium text-ink">All clear for today 🎉</p>
              <p className="mt-1 text-[13px] text-muted">
                {done.length} done. That’s a good day’s work.
              </p>
            </div>
          ) : null}

          {anytime.length ? (
            <TaskGroup
              title={empty ? "Anytime — pick something" : "Anytime"}
              count={anytime.length}
              tone="muted"
            >
              <TaskList tasks={anytimeShown} projects={projects} onOpen={setEditing} />
              {anytime.length > anytimeShown.length ? (
                <div className="mt-2 flex items-center justify-between gap-3 px-1">
                  <span className="text-[12px] text-faint">
                    A different few every few hours
                  </span>
                  <Link href="/upcoming" className="shrink-0 text-[13px] font-medium text-accent">
                    See all {anytime.length}
                  </Link>
                </div>
              ) : null}
            </TaskGroup>
          ) : null}

          {done.length ? (
            <TaskGroup title="Done today" count={done.length} tone="muted" collapsible defaultCollapsed>
              <TaskList tasks={done} projects={projects} onOpen={setEditing} />
            </TaskGroup>
          ) : null}
        </>
      )}


      <TaskEditor open={!!editing} task={editing} onClose={() => setEditing(null)} />
      <QuickAddSheet open={quickOpen} onClose={() => setQuickOpen(false)} />
    </Page>
  );
}
