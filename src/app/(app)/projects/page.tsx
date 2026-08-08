"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { AnimatePresence, motion } from "framer-motion";
import { fetcher, keys } from "@/lib/api";
import type { Project, Task } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Page } from "@/components/shell/Page";
import { EmptyState, PageHeader, SectionLabel, SkeletonRows } from "@/components/ui/Misc";
import { Button } from "@/components/ui/Button";
import { IconChevronRight, IconPlus, IconX } from "@/components/ui/icons";
import { ProjectSheet } from "@/components/projects/ProjectSheet";
import { TaskEditor } from "@/components/tasks/TaskEditor";
import { TaskList } from "@/components/tasks/TaskList";

export default function ProjectsPage() {
  const { data, isLoading, mutate } = useSWR<{ projects: Project[] }>(keys.projects(), fetcher);
  const { data: tagData } = useSWR<{ tags: string[] }>(keys.tags(), fetcher);
  const [creating, setCreating] = useState(false);
  const [tag, setTag] = useState<string | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setTag(params.get("tag"));
  }, []);

  const selectTag = useCallback((next: string | null) => {
    setTag(next);
    const url = next ? `/projects?tag=${encodeURIComponent(next)}` : "/projects";
    window.history.replaceState({}, "", url);
  }, []);

  const { data: tagTasks, isLoading: tagLoading } = useSWR<{ tasks: Task[] }>(
    tag ? keys.tasks({ tag, view: "all" }) : null,
    fetcher,
  );

  const projects = (data?.projects ?? []).filter((p) => !p.archived);
  const tags = tagData?.tags ?? [];

  return (
    <Page>
      <PageHeader
        title="Projects"
        subtitle="Buckets for the things that belong together."
        actions={
          <Button variant="primary" size="sm" icon={<IconPlus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            New
          </Button>
        }
      />

      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : projects.length === 0 ? (
        <EmptyState
          emoji="📁"
          title="No projects yet"
          message="Group related tasks — “Home”, “Work”, “Someday”."
          action={
            <Button variant="primary" icon={<IconPlus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              Create a project
            </Button>
          }
        />
      ) : (
        <ul className="space-y-2">
          <AnimatePresence initial={false}>
            {projects.map((project) => (
              <motion.li
                key={project.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                <Link
                  href={`/projects/${project.id}`}
                  className="flex min-h-[64px] items-center gap-3 overflow-hidden rounded-2xl border border-stroke bg-elev pr-3 transition-colors hover:border-stroke-strong"
                >
                  <span
                    className="h-full w-1.5 self-stretch"
                    style={{ background: project.color }}
                    aria-hidden="true"
                  />
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-sunken text-lg">
                    {project.icon}
                  </span>
                  <span className="min-w-0 flex-1 py-3">
                    <span className="block truncate text-[15px] font-medium text-ink">
                      {project.name}
                    </span>
                    <span className="block text-[13px] text-muted">
                      {project.openCount ?? 0} open
                    </span>
                  </span>
                  <IconChevronRight className="h-4 w-4 shrink-0 text-faint" />
                </Link>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      {tags.length ? (
        <section className="mt-8">
          <SectionLabel>Tags</SectionLabel>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => selectTag(tag === t ? null : t)}
                className={cn(
                  "min-h-[36px] rounded-full border px-3 text-[13px] transition-colors",
                  tag === t
                    ? "border-transparent bg-accent-soft font-medium text-accent"
                    : "border-stroke bg-elev text-muted hover:text-ink",
                )}
              >
                #{t}
              </button>
            ))}
          </div>

          {tag ? (
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between px-1">
                <h3 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">
                  Tagged #{tag}
                </h3>
                <button
                  type="button"
                  onClick={() => selectTag(null)}
                  className="inline-flex items-center gap-1 text-[13px] text-accent"
                >
                  <IconX className="h-3.5 w-3.5" /> Clear
                </button>
              </div>
              {tagLoading ? (
                <SkeletonRows rows={2} />
              ) : (tagTasks?.tasks ?? []).length === 0 ? (
                <p className="rounded-2xl border border-stroke bg-elev px-4 py-5 text-center text-[14px] text-muted">
                  Nothing tagged #{tag} right now.
                </p>
              ) : (
                <TaskList
                  tasks={(tagTasks?.tasks ?? []).filter((t) => !t.parentId)}
                  projects={projects}
                  onOpen={setEditing}
                />
              )}
            </div>
          ) : null}
        </section>
      ) : null}

      <ProjectSheet
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={() => void mutate()}
      />
      <TaskEditor open={!!editing} task={editing} onClose={() => setEditing(null)} />
    </Page>
  );
}
