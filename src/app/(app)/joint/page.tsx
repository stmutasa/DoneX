"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { fetcher, keys, tasksApi } from "@/lib/api";
import type { Task } from "@/lib/types";
import { Page } from "@/components/shell/Page";
import { EmptyState, PageHeader, SkeletonRows } from "@/components/ui/Misc";
import { useToast } from "@/components/ui/Toast";
import { IconPlus } from "@/components/ui/icons";
import { TaskEditor } from "@/components/tasks/TaskEditor";
import { TaskGroup, TaskList } from "@/components/tasks/TaskList";
import { Segmented } from "@/components/ui/Segmented";
import { cn } from "@/lib/utils";
import { JointCalendar } from "@/components/joint/JointCalendar";

/**
 * The shared list. Identical for both people: the owner reaches it as one tab
 * among many; a partner session lives here. Attribution chips show who added
 * what, so "we're out of milk" has a culprit.
 */
export default function JointPage() {
  const toast = useToast();
  const { data, isLoading, mutate } = useSWR<{ tasks: Task[] }>(
    keys.tasks({ space: "joint", includeDone: true }),
    fetcher,
    { refreshInterval: 60_000 },
  );
  const { data: me } = useSWR<{
    role: "owner" | "partner";
    ownerName: string;
    partnerName: string;
    ownerColor?: string;
    partnerColor?: string;
  }>(keys.me(), fetcher);

  const [editing, setEditing] = useState<Task | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState<"list" | "calendar">("list");

  const tasks = useMemo(() => (data?.tasks ?? []).filter((t) => !t.parentId), [data]);
  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done").slice(0, 20);

  const names = { owner: me?.ownerName || "Me", partner: me?.partnerName || "Partner" };
  const colors = { owner: me?.ownerColor, partner: me?.partnerColor };
  const attribution = { ...names, colors };

  const add = async () => {
    const value = draft.trim();
    if (!value || adding) return;
    setAdding(true);
    try {
      await tasksApi.create({ quick: value, space: "joint" });
      setDraft("");
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add that");
    } finally {
      setAdding(false);
    }
  };

  return (
    <Page width="wide">
      <PageHeader
        title="Ours"
        subtitle={`What ${names.owner} and ${names.partner} share.`}
      />

      <div className="mb-4 xl:hidden">
        <Segmented
          size="sm"
          ariaLabel="Joint view"
          value={tab}
          onChange={setTab}
          options={[
            { value: "list" as const, label: "List" },
            { value: "calendar" as const, label: "Calendar" },
          ]}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)] xl:gap-8">
        <section className={cn(tab === "list" ? "block" : "hidden", "xl:block")}>
          <div className="mb-5 flex items-center gap-2 rounded-2xl border border-stroke bg-elev px-3.5 py-1.5">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void add();
                }
              }}
              placeholder="Add to our list… (“pick up the cake saturday 2pm”)"
              enterKeyHint="done"
              className="min-h-[44px] w-full bg-transparent text-[15px] text-ink outline-none placeholder:text-faint"
            />
            <button
              type="button"
              onClick={() => void add()}
              disabled={!draft.trim() || adding}
              aria-label="Add to the joint list"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-sunrise text-on-accent disabled:opacity-40"
            >
              <IconPlus className="h-5 w-5" strokeWidth={2.2} />
            </button>
          </div>

          {isLoading ? (
            <SkeletonRows rows={4} />
          ) : open.length === 0 && done.length === 0 ? (
            <EmptyState
              emoji="💛"
              title="Nothing here yet"
              message="Add the first thing you two need to get done."
            />
          ) : (
            <>
              {open.length ? (
                <TaskGroup title="To do" count={open.length}>
                  <TaskList tasks={open} projects={[]} onOpen={setEditing} showProject={false} attribution={attribution} />
                </TaskGroup>
              ) : (
                <div className="mb-6 rounded-2xl border border-stroke bg-elev px-4 py-6 text-center">
                  <p className="text-[15px] font-medium text-ink">All done 🎉</p>
                  <p className="mt-1 text-[13px] text-muted">The shared list is clear.</p>
                </div>
              )}
              {done.length ? (
                <TaskGroup title="Done" count={done.length} tone="muted" collapsible defaultCollapsed>
                  <TaskList tasks={done} projects={[]} onOpen={setEditing} showProject={false} attribution={attribution} />
                </TaskGroup>
              ) : null}
            </>
          )}
        </section>

        <section className={cn(tab === "calendar" ? "block" : "hidden", "xl:block")}>
          <JointCalendar names={names} colors={colors} />
        </section>
      </div>

      <TaskEditor open={!!editing} task={editing} onClose={() => setEditing(null)} />
    </Page>
  );
}
