"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { fetcher, keys } from "@/lib/api";
import type { Project, StatsSummary, Task } from "@/lib/types";
import { greeting, isOverdue, longDateLine } from "@/lib/format";
import { useInstallPrompt } from "@/hooks/useInstallPrompt";
import { Page } from "@/components/shell/Page";
import { Button } from "@/components/ui/Button";
import { EmptyState, SkeletonRows } from "@/components/ui/Misc";
import { IconDownload, IconPlus } from "@/components/ui/icons";
import { TaskEditor } from "@/components/tasks/TaskEditor";
import { TaskGroup, TaskList } from "@/components/tasks/TaskList";
import { QuickAddSheet } from "@/components/tasks/QuickAdd";
import { BriefingCard } from "@/components/today/BriefingCard";
import { CalendarStrip } from "@/components/today/CalendarStrip";
import { PlanStrip } from "@/components/plan/PlanStrip";

export default function TodayPage() {
  const { data, isLoading } = useSWR<{ tasks: Task[] }>(
    keys.tasks({ view: "today", includeDone: true }),
    fetcher,
  );
  const { data: projectData } = useSWR<{ projects: Project[] }>(keys.projects(), fetcher);
  const { data: stats } = useSWR<StatsSummary>(keys.stats(), fetcher);
  const install = useInstallPrompt();

  const [editing, setEditing] = useState<Task | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => setNow(new Date()), []);

  const projects = projectData?.projects ?? [];
  const all = useMemo(() => (data?.tasks ?? []).filter((t) => !t.parentId), [data]);

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
  }, [all]);

  const streak = stats?.streakDays ?? 0;
  const empty = !isLoading && overdue.length === 0 && today.length === 0;

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
        <BriefingCard tasks={all} onFocusTask={setEditing} />
        <CalendarStrip />
        <PlanStrip tasks={all} />
        {install.available ? (
          <button
            type="button"
            onClick={() => void install.promptInstall()}
            className="flex w-full items-center gap-2 rounded-full border border-stroke bg-elev px-4 py-2.5 text-left text-[13px] text-muted"
          >
            <IconDownload className="h-4 w-4 text-accent" />
            Install DoneX to your home screen
          </button>
        ) : null}
      </div>

      {isLoading ? (
        <SkeletonRows rows={4} />
      ) : empty && done.length === 0 ? (
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
