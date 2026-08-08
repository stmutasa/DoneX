"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { format } from "date-fns";
import { fetcher, keys, projectsApi, tasksApi } from "@/lib/api";
import type { Priority, Project, RecurrenceRule, Task, TaskDraft } from "@/lib/types";
import { toDateInput } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAutoGrow } from "@/hooks/useAutoGrow";
import { Button, IconButton } from "@/components/ui/Button";
import { FieldLabel, Input, Select, Switch } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { Sheet } from "@/components/ui/Sheet";
import { useConfirm } from "@/components/ui/Confirm";
import { useToast } from "@/components/ui/Toast";
import { IconCheck, IconPlus, IconTrash, IconX } from "@/components/ui/icons";
import { RecurrenceBuilder } from "./RecurrenceBuilder";
import { TagInput } from "./TagInput";
import { useTaskMutations } from "./useTaskMutations";

export interface TaskEditorProps {
  open: boolean;
  onClose: () => void;
  task?: Task | null;
  initial?: Partial<TaskDraft>;
  onSaved?: (task: Task) => void;
  /** Create mode: handle the draft yourself instead of POSTing a task. */
  onSubmitDraft?: (draft: TaskDraft) => void | Promise<void>;
  submitLabel?: string;
}

interface FormState {
  title: string;
  notes: string;
  dueDate: string;
  dueTime: string;
  allDay: boolean;
  priority: Priority;
  projectId: string;
  tags: string[];
  recurrence: RecurrenceRule | null;
}

function stateFrom(task?: Task | null, initial?: Partial<TaskDraft>): FormState {
  const src = task ?? initial;
  const dueAt = src?.dueAt ?? null;
  const allDay = src?.allDay ?? false;
  return {
    title: src?.title ?? "",
    notes: src?.notes ?? "",
    dueDate: toDateInput(dueAt),
    dueTime: dueAt && !allDay ? format(new Date(dueAt), "HH:mm") : "",
    allDay,
    priority: (src?.priority ?? 0) as Priority,
    projectId: src?.projectId ?? "",
    tags: src?.tags ?? [],
    recurrence: src?.recurrence ?? null,
  };
}

function composeDue(s: FormState): string | null {
  if (!s.dueDate) return null;
  const iso = s.allDay
    ? new Date(`${s.dueDate}T00:00:00`)
    : new Date(`${s.dueDate}T${s.dueTime || "09:00"}`);
  return Number.isNaN(iso.getTime()) ? null : iso.toISOString();
}

export function TaskEditor({
  open,
  onClose,
  task,
  initial,
  onSaved,
  onSubmitDraft,
  submitLabel,
}: TaskEditorProps) {
  const { save, create, remove, revalidate } = useTaskMutations();
  const confirm = useConfirm();
  const toast = useToast();

  const [form, setForm] = useState<FormState>(() => stateFrom(task, initial));
  const [saving, setSaving] = useState(false);
  const [subtasks, setSubtasks] = useState<Task[]>(task?.subtasks ?? []);
  const [subtaskDraft, setSubtaskDraft] = useState("");
  const [newProject, setNewProject] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const notesRef = useRef<HTMLTextAreaElement>(null);

  useAutoGrow(notesRef, form.notes, 260);

  const { data: projectData, mutate: mutateProjects } = useSWR<{ projects: Project[] }>(
    open ? keys.projects() : null,
    fetcher,
  );
  const { data: tagData } = useSWR<{ tags: string[] }>(open ? keys.tags() : null, fetcher);
  const projects = useMemo(() => projectData?.projects ?? [], [projectData]);

  useEffect(() => {
    if (!open) return;
    setForm(stateFrom(task, initial));
    setSubtasks(task?.subtasks ?? []);
    setSubtaskDraft("");
    setCreatingProject(false);
    setNewProject("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const quickDate = (offset: number | null) => {
    if (offset === null) {
      setForm((p) => ({ ...p, dueDate: "", dueTime: "" }));
      return;
    }
    const d = new Date();
    d.setDate(d.getDate() + offset);
    set("dueDate", format(d, "yyyy-MM-dd"));
  };

  const buildDraft = (): TaskDraft => ({
    title: form.title.trim(),
    notes: form.notes,
    priority: form.priority,
    dueAt: composeDue(form),
    allDay: form.allDay,
    projectId: form.projectId || null,
    tags: form.tags,
    recurrence: form.recurrence,
  });

  const submit = async () => {
    const draft = buildDraft();
    if (!draft.title) {
      toast.error("Give it a title first");
      return;
    }
    setSaving(true);
    try {
      if (onSubmitDraft) {
        await onSubmitDraft(draft);
        onClose();
        return;
      }
      const saved = task ? await save(task.id, draft) : await create(draft);
      if (saved) {
        onSaved?.(saved);
        onClose();
      }
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async () => {
    if (!task) return;
    const ok = await confirm({
      title: "Delete this task?",
      message: task.title,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    if (await remove(task.id)) {
      toast.success("Task deleted");
      onClose();
    }
  };

  const addProject = async () => {
    const name = newProject.trim();
    if (!name) return;
    try {
      const { project } = await projectsApi.create({ name });
      await mutateProjects();
      set("projectId", project.id);
      setCreatingProject(false);
      setNewProject("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create project");
    }
  };

  const addSubtask = async () => {
    const title = subtaskDraft.trim();
    if (!title || !task) return;
    setSubtaskDraft("");
    try {
      const { task: child } = await tasksApi.create({ title, parentId: task.id });
      setSubtasks((prev) => [...prev, child]);
      revalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not add subtask");
    }
  };

  const toggleSubtask = async (child: Task) => {
    const next = child.status === "done" ? "open" : "done";
    setSubtasks((prev) =>
      prev.map((s) => (s.id === child.id ? { ...s, status: next as Task["status"] } : s)),
    );
    try {
      await tasksApi.complete(child.id, next === "done");
      revalidate();
    } catch {
      setSubtasks((prev) =>
        prev.map((s) => (s.id === child.id ? { ...s, status: child.status } : s)),
      );
      toast.error("Could not update subtask");
    }
  };

  const deleteSubtask = async (child: Task) => {
    setSubtasks((prev) => prev.filter((s) => s.id !== child.id));
    try {
      await tasksApi.remove(child.id);
      revalidate();
    } catch {
      toast.error("Could not delete subtask");
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="lg"
      title={task ? "Edit task" : "New task"}
      actions={
        task ? (
          <IconButton label="Delete task" size="sm" onClick={onDelete} className="text-danger">
            <IconTrash className="h-[18px] w-[18px]" />
          </IconButton>
        ) : null
      }
      footer={
        <div className="flex gap-2">
          <Button block onClick={onClose}>
            Cancel
          </Button>
          <Button block variant="primary" loading={saving} onClick={submit}>
            {submitLabel ?? (task ? "Save" : "Add task")}
          </Button>
        </div>
      }
    >
      <div className="space-y-4 pt-1">
        <input
          value={form.title}
          onChange={(e) => set("title", e.target.value)}
          placeholder="What needs doing?"
          autoFocus={!task}
          className="w-full bg-transparent text-[19px] font-medium text-ink outline-none placeholder:text-faint"
        />

        <textarea
          ref={notesRef}
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
          placeholder="Notes…"
          rows={1}
          className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-muted outline-none placeholder:text-faint"
        />

        <div className="rounded-2xl border border-stroke bg-sunken p-3">
          <div className="mb-2 flex items-center justify-between">
            <FieldLabel>Due</FieldLabel>
            <label className="flex items-center gap-2 text-[13px] text-muted">
              All-day
              <Switch
                label="All-day"
                checked={form.allDay}
                onChange={(v) => set("allDay", v)}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <input
              type="date"
              value={form.dueDate}
              onChange={(e) => set("dueDate", e.target.value)}
              className="h-11 flex-1 rounded-xl border border-stroke bg-elev px-3 text-[15px] text-ink outline-none"
            />
            <input
              type="time"
              value={form.dueTime}
              disabled={form.allDay || !form.dueDate}
              onChange={(e) => set("dueTime", e.target.value)}
              className="h-11 w-[124px] rounded-xl border border-stroke bg-elev px-3 text-[15px] text-ink outline-none disabled:opacity-40"
            />
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {[
              { label: "Today", offset: 0 },
              { label: "Tomorrow", offset: 1 },
              { label: "Next week", offset: 7 },
            ].map((chip) => (
              <button
                key={chip.label}
                type="button"
                onClick={() => quickDate(chip.offset)}
                className="rounded-full border border-stroke bg-elev px-2.5 py-1 text-[12px] text-muted transition-colors hover:text-ink"
              >
                {chip.label}
              </button>
            ))}
            {form.dueDate ? (
              <button
                type="button"
                onClick={() => quickDate(null)}
                className="inline-flex items-center gap-1 rounded-full border border-stroke bg-elev px-2.5 py-1 text-[12px] text-muted transition-colors hover:text-ink"
              >
                <IconX className="h-3 w-3" /> Clear
              </button>
            ) : null}
          </div>
        </div>

        <div>
          <FieldLabel>Priority</FieldLabel>
          <Segmented
            size="sm"
            ariaLabel="Priority"
            value={form.priority}
            onChange={(v) => set("priority", v)}
            options={[
              { value: 0 as Priority, label: "None" },
              { value: 1 as Priority, label: "P3" },
              { value: 2 as Priority, label: "P2" },
              { value: 3 as Priority, label: "P1" },
            ]}
          />
        </div>

        <div>
          <FieldLabel>Project</FieldLabel>
          {creatingProject ? (
            <div className="flex gap-2">
              <Input
                value={newProject}
                autoFocus
                placeholder="Project name"
                onChange={(e) => setNewProject(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addProject()}
              />
              <Button variant="primary" onClick={addProject}>
                Add
              </Button>
            </div>
          ) : (
            <div className="flex gap-2">
              <Select value={form.projectId} onChange={(e) => set("projectId", e.target.value)}>
                <option value="">No project</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.icon} {p.name}
                  </option>
                ))}
              </Select>
              <Button
                onClick={() => setCreatingProject(true)}
                icon={<IconPlus className="h-4 w-4" />}
                aria-label="New project"
              >
                New
              </Button>
            </div>
          )}
        </div>

        <TagInput
          value={form.tags}
          onChange={(tags) => set("tags", tags)}
          suggestions={tagData?.tags ?? []}
        />

        <RecurrenceBuilder value={form.recurrence} onChange={(r) => set("recurrence", r)} />

        {task ? (
          <div>
            <FieldLabel>
              Subtasks{subtasks.length ? ` · ${subtasks.filter((s) => s.status === "done").length}/${subtasks.length}` : ""}
            </FieldLabel>
            <div className="space-y-1.5">
              {subtasks.map((child) => (
                <div
                  key={child.id}
                  className="flex items-center gap-2.5 rounded-xl border border-stroke bg-sunken px-2.5 py-2"
                >
                  <button
                    type="button"
                    onClick={() => toggleSubtask(child)}
                    aria-label={child.status === "done" ? "Mark undone" : "Mark done"}
                    className={cn(
                      "grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 transition-colors",
                      child.status === "done"
                        ? "border-transparent bg-sunrise text-on-accent"
                        : "border-stroke-strong text-transparent",
                    )}
                  >
                    <IconCheck className="h-3 w-3" strokeWidth={3} />
                  </button>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[14px] text-ink",
                      child.status === "done" && "task-done-title",
                    )}
                  >
                    {child.title}
                  </span>
                  <IconButton
                    label={`Delete subtask ${child.title}`}
                    size="sm"
                    onClick={() => deleteSubtask(child)}
                  >
                    <IconX className="h-3.5 w-3.5" />
                  </IconButton>
                </div>
              ))}
              <div className="flex gap-2">
                <Input
                  value={subtaskDraft}
                  placeholder="Add a subtask…"
                  onChange={(e) => setSubtaskDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void addSubtask();
                    }
                  }}
                />
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
