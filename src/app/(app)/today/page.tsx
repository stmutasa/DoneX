"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { fetcher, keys } from "@/lib/api";
import type { Project, StatsSummary, Task } from "@/lib/types";
import { greeting, isOverdue, longDateLine } from "@/lib/format";
import { isUrgent } from "@/lib/deadline";
import { rotatingSample, rotationSlot } from "@/lib/rotate";
import { Page } from "@/components/shell/Page";
import { Button } from "@/components/ui/Button";
import { EmptyState, SkeletonRows } from "@/components/ui/Misc";
import { IconPlus } from "@/components/ui/icons";
import { TaskEditor } from "@/components/tasks/TaskEditor";
import { TaskGroup, TaskList } from "@/components/tasks/TaskList";
import { QuickAddSheet } from "@/components/tasks/QuickAdd";
import { BriefingCard } from "@/components/today/BriefingCard";
import { CalendarStrip } from "@/components/today/CalendarStrip";
import { PlanStrip } from "@/components/plan/PlanStrip";

const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export default function TodayPage() {
  const { data, isLoading } = useSWR<{ tasks: Task[] }>(
    keys.tasks({ view: "today", includeDone: true }),
    fetcher,
  );
  const { data: anytimeData } = useSWR<{ tasks: Task[] }>(
    keys.tasks({ view: "anytime" }),
    fetcher,
  );
  const { data: projectData } = useSWR<{ projects: Project[] }>(keys.projects(), fetcher);
  const { data: stats } = useSWR<StatsSummary>(keys.stats(), fetcher);

  const [editing, setEditing] = useState<Task | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [now, setNow] = useState<Date | null>(null);
  const [slot, setSlot] = useState(() => rotationSlot());

  useEffect(() => setNow(new Date()), []);

  // Advance the Anytime rotation while the app sits open on the home screen.
  useEffect(() => {
    const tick = () => setSlot(rotationSlot());
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
  const all = useMemo(() => (data?.tasks ?? []).filter((t) => !t.parentId), [data]);
  // Project work lives on its own tab — except when it's about to bite:
  // overdue, due today, or a deadline landing by tomorrow.
  const loose = useMemo(
    () => all.filter((t) => !t.projectId || isUrgent(t, deviceTz, now ?? undefined)),
    [all, now],
  );

  const { overdue, today, done } = useMemo(() => {
    const o: Task[] = [];
    const t: Task[] = [];
    const d: Task[] = [];
    for (const task of loose) {
      if (task.status === "done") d.push(task);
      else if (isOverdue(task.dueAt, task.allDay)) o.push(task);
      else t.push(task);
    }
    return { overdue: o, today: t, done: d };
  }, [loose]);

  const anytime = useMemo(
    () =>
      (anytimeData?.tasks ?? []).filter(
        (t) => !t.parentId && !t.projectId && t.status !== "done",
      ),
    [anytimeData],
  );
  // A different handful every few hours, steady in between.
  const anytimeShown = useMemo(() => rotatingSample(anytime, 8, slot), [anytime, slot]);

  const streak = stats?.streakDays ?? 0;
  const empty = !isLoading && overdue.length === 0 && today.length === 0;

  // The top of the page belongs to whatever is useful right now: the briefing
  // and the plan lead in the morning, then step aside for the list itself.
  // Rendered only once the clock is known, so nothing jumps after hydration.
  const morning = now !== null && now.getHours() < 12;
  const leadWith = now !== null && morning;
  const trailWith = now !== null && !morning;

  return (
    <Page>
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

      <div className="mb-6 space-y-3">
        {leadWith ? <BriefingCard tasks={all} onFocusTask={setEditing} /> : null}
        <CalendarStrip />
        {leadWith ? <PlanStrip tasks={all} /> : null}
      </div>

      {isLoading ? (
        <SkeletonRows rows={4} />
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

      {trailWith ? (
        <div className="mt-6 space-y-3">
          <PlanStrip tasks={all} />
          <BriefingCard tasks={all} onFocusTask={setEditing} />
        </div>
      ) : null}

      <TaskEditor open={!!editing} task={editing} onClose={() => setEditing(null)} />
      <QuickAddSheet open={quickOpen} onClose={() => setQuickOpen(false)} />
    </Page>
  );
}
