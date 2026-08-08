"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import { fetcher, keys, matchKey, projectsApi } from "@/lib/api";
import type { Project, Task } from "@/lib/types";
import { Page } from "@/components/shell/Page";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState, SkeletonRows } from "@/components/ui/Misc";
import { useConfirm } from "@/components/ui/Confirm";
import { useToast } from "@/components/ui/Toast";
import { IconArchive, IconChevronLeft, IconPencil, IconPlus, IconTrash } from "@/components/ui/icons";
import { ProjectSheet } from "@/components/projects/ProjectSheet";
import { TaskEditor } from "@/components/tasks/TaskEditor";
import { TaskGroup, TaskList } from "@/components/tasks/TaskList";
import { QuickAddSheet } from "@/components/tasks/QuickAdd";

export default function ProjectDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const { mutate: globalMutate } = useSWRConfig();

  const { data: projectData, mutate: mutateProjects } = useSWR<{ projects: Project[] }>(
    keys.projects(),
    fetcher,
  );
  const { data, isLoading } = useSWR<{ tasks: Task[] }>(
    id ? keys.tasks({ projectId: id, includeDone: true }) : null,
    fetcher,
  );

  const [editingProject, setEditingProject] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);

  const projects = useMemo(() => projectData?.projects ?? [], [projectData]);
  const project = projects.find((p) => p.id === id) ?? null;

  const tasks = useMemo(() => (data?.tasks ?? []).filter((t) => !t.parentId), [data]);
  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");

  useEffect(() => {
    if (!isLoading && projectData && !project) router.replace("/projects");
  }, [isLoading, projectData, project, router]);

  const archive = async () => {
    if (!project) return;
    try {
      await projectsApi.update(project.id, { archived: !project.archived });
      await mutateProjects();
      toast.success(project.archived ? "Project restored" : "Project archived");
      if (!project.archived) router.push("/projects");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not archive project");
    }
  };

  const remove = async () => {
    if (!project) return;
    const ok = await confirm({
      title: `Delete “${project.name}”?`,
      message: "Tasks in this project won’t be deleted — they’ll just lose their project.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await projectsApi.remove(project.id);
      void globalMutate(matchKey("/api/projects", "/api/tasks"));
      toast.success("Project deleted");
      router.push("/projects");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete project");
    }
  };

  return (
    <Page>
      <Link
        href="/projects"
        className="mb-3 inline-flex min-h-[36px] items-center gap-1 text-[13.5px] text-muted transition-colors hover:text-ink"
      >
        <IconChevronLeft className="h-4 w-4" /> Projects
      </Link>

      <header className="mb-5 flex items-start gap-3">
        <span
          className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl text-xl"
          style={{ background: project ? `color-mix(in srgb, ${project.color} 18%, var(--bg-elev))` : undefined }}
        >
          {project?.icon ?? "📁"}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-ink">
            {project?.name ?? "…"}
          </h1>
          <p className="mt-0.5 text-[13.5px] text-muted">
            {open.length} open · {done.length} done
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton label="Edit project" onClick={() => setEditingProject(true)}>
            <IconPencil className="h-[18px] w-[18px]" />
          </IconButton>
          <IconButton label={project?.archived ? "Restore project" : "Archive project"} onClick={archive}>
            <IconArchive className="h-[18px] w-[18px]" />
          </IconButton>
          <IconButton label="Delete project" className="text-danger" onClick={remove}>
            <IconTrash className="h-[18px] w-[18px]" />
          </IconButton>
        </div>
      </header>

      <Button
        block
        className="mb-5"
        icon={<IconPlus className="h-4 w-4 text-accent" />}
        onClick={() => setQuickOpen(true)}
      >
        Add to {project?.name ?? "project"}
      </Button>

      {isLoading ? (
        <SkeletonRows rows={4} />
      ) : tasks.length === 0 ? (
        <EmptyState
          emoji="🌱"
          title="Nothing here yet"
          message="Add the first task and this project starts to breathe."
          action={
            <Button variant="primary" icon={<IconPlus className="h-4 w-4" />} onClick={() => setQuickOpen(true)}>
              Add a task
            </Button>
          }
        />
      ) : (
        <>
          {open.length ? (
            <TaskGroup title="Open" count={open.length}>
              <TaskList tasks={open} projects={projects} onOpen={setEditingTask} showProject={false} />
            </TaskGroup>
          ) : null}
          {done.length ? (
            <TaskGroup title="Done" count={done.length} tone="muted" collapsible defaultCollapsed>
              <TaskList tasks={done} projects={projects} onOpen={setEditingTask} showProject={false} />
            </TaskGroup>
          ) : null}
        </>
      )}

      <ProjectSheet
        open={editingProject}
        project={project}
        onClose={() => setEditingProject(false)}
        onSaved={() => void mutateProjects()}
      />
      <TaskEditor open={!!editingTask} task={editingTask} onClose={() => setEditingTask(null)} />
      <QuickAddSheet open={quickOpen} onClose={() => setQuickOpen(false)} projectId={id} />
    </Page>
  );
}
