"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { differenceInCalendarDays } from "date-fns";
import { fetcher, keys } from "@/lib/api";
import type { Project, Task } from "@/lib/types";
import { dateKey, dayHeading, monthHeading } from "@/lib/format";
import { Page } from "@/components/shell/Page";
import { PageHeader, EmptyState, SkeletonRows } from "@/components/ui/Misc";
import { Button } from "@/components/ui/Button";
import { IconPlus } from "@/components/ui/icons";
import { TaskEditor } from "@/components/tasks/TaskEditor";
import { TaskGroup, TaskList } from "@/components/tasks/TaskList";
import { QuickAddSheet } from "@/components/tasks/QuickAdd";

interface Bucket {
  key: string;
  title: string;
  tasks: Task[];
}

function buildBuckets(tasks: Task[]): Bucket[] {
  const days = new Map<string, Task[]>();
  const months = new Map<string, Task[]>();

  for (const task of tasks) {
    if (!task.dueAt) continue;
    const key = dateKey(task.dueAt);
    const diff = differenceInCalendarDays(new Date(task.dueAt), new Date());
    if (diff <= 13) {
      const list = days.get(key) ?? [];
      list.push(task);
      days.set(key, list);
    } else {
      const monthKey = `${key.slice(0, 7)}-01`;
      const list = months.get(monthKey) ?? [];
      list.push(task);
      months.set(monthKey, list);
    }
  }

  const dayBuckets = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => ({ key, title: dayHeading(key), tasks: list }));

  const monthBuckets = [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => ({ key: `m-${key}`, title: monthHeading(key), tasks: list }));

  return [...dayBuckets, ...monthBuckets];
}

export default function UpcomingPage() {
  const { data, isLoading } = useSWR<{ tasks: Task[] }>(
    keys.tasks({ view: "upcoming", excludeProjects: true }),
    fetcher,
  );
  const { data: anytimeData } = useSWR<{ tasks: Task[] }>(
    keys.tasks({ view: "anytime", excludeProjects: true }),
    fetcher,
  );
  const { data: projectData } = useSWR<{ projects: Project[] }>(keys.projects(), fetcher);

  const [editing, setEditing] = useState<Task | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);

  const projects = projectData?.projects ?? [];
  const upcoming = useMemo(() => (data?.tasks ?? []).filter((t) => !t.parentId), [data]);
  const anytime = useMemo(
    () => (anytimeData?.tasks ?? []).filter((t) => !t.parentId && t.status !== "done"),
    [anytimeData],
  );
  const buckets = useMemo(() => buildBuckets(upcoming), [upcoming]);

  const empty = !isLoading && buckets.length === 0 && anytime.length === 0;

  return (
    <Page>
      <PageHeader
        title="Upcoming"
        subtitle="The next two weeks, and everything after."
      />

      {isLoading ? (
        <SkeletonRows rows={5} />
      ) : empty ? (
        <EmptyState
          emoji="🗓️"
          title="Nothing scheduled ahead"
          message="Your future is refreshingly empty. Plan something when you’re ready."
          action={
            <Button
              variant="primary"
              icon={<IconPlus className="h-4 w-4" />}
              onClick={() => setQuickOpen(true)}
            >
              Add a task
            </Button>
          }
        />
      ) : (
        <>
          {buckets.map((bucket) => (
            <TaskGroup key={bucket.key} title={bucket.title} count={bucket.tasks.length}>
              <TaskList tasks={bucket.tasks} projects={projects} onOpen={setEditing} />
            </TaskGroup>
          ))}

          {anytime.length ? (
            <TaskGroup title="Anytime" count={anytime.length} tone="muted">
              <TaskList tasks={anytime} projects={projects} onOpen={setEditing} />
            </TaskGroup>
          ) : null}
        </>
      )}

      <TaskEditor open={!!editing} task={editing} onClose={() => setEditing(null)} />
      <QuickAddSheet open={quickOpen} onClose={() => setQuickOpen(false)} />
    </Page>
  );
}
