"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { fetcher, keys, projectsApi, tasksApi } from "@/lib/api";
import type { Priority, Project, RecurrenceRule, SessionRole, Task, TaskDraft } from "@/lib/types";
import { addDaysToDateKey, cn } from "@/lib/utils";
import { useAutoGrow } from "@/hooks/useAutoGrow";
import { Button, IconButton } from "@/components/ui/Button";
import { FieldLabel, Input, Select, Switch } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { Sheet } from "@/components/ui/Sheet";
import { useConfirm } from "@/components/ui/Confirm";
import { useToast } from "@/components/ui/Toast";
import { IconCheck, IconPlus, IconTrash, IconX } from "@/components/ui/icons";
import { LocationField } from "./LocationField";
import { RecurrenceBuilder } from "./RecurrenceBuilder";
import { TagInput } from "./TagInput";
import { useTaskMutations } from "./useTaskMutations";
import {
  buildDraft,
  changedFields,
  defaultTime,
  firstOccurrenceKey,
  isAllDay,
  stateFrom,
  todayKey,
  type FormState,
} from "./taskForm";

const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

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

  const { data: me } = useSWR<{
    role: SessionRole;
    ownerName: string;
    partnerName: string;
    tz?: string;
  }>(open ? keys.me() : null, fetcher);
  // All-day dates are midnight in the app's time zone (settings.tz), not the
  // device's. /api/auth/me carries it for both roles; until it does, the owner
  // can read it from settings, and the device zone is the last resort.
  const { data: settings } = useSWR<{ tz: string }>(
    open && me?.role === "owner" && !me.tz ? keys.settings() : null,
    fetcher,
  );
  const tz = me?.tz || settings?.tz || deviceTz;

  const [form, setForm] = useState<FormState>(() => stateFrom(task, initial, tz));
  /** The form as it was opened, so a save sends only what changed. */
  const baseRef = useRef<FormState>(form);
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
  const myRole: SessionRole = me?.role ?? "owner";
  const theirRole: SessionRole = myRole === "owner" ? "partner" : "owner";
  const theirName =
    (myRole === "owner" ? me?.partnerName : me?.ownerName) || "Them";
  const projects = useMemo(() => projectData?.projects ?? [], [projectData]);

  useEffect(() => {
    if (!open) return;
    const next = stateFrom(task, initial, tz);
    baseRef.current = next;
    setForm(next);
    setSubtasks(task?.subtasks ?? []);
    setSubtaskDraft("");
    setCreatingProject(false);
    setNewProject("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id]);

  // The app's time zone can arrive just after the sheet opens. Re-read the
  // dates with it, but only while nothing has been touched yet.
  useEffect(() => {
    if (!open || JSON.stringify(form) !== JSON.stringify(baseRef.current)) return;
    const next = stateFrom(task, initial, tz);
    baseRef.current = next;
    setForm(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const setDueDate = (dueDate: string) =>
    setForm((p) => ({ ...p, dueDate, dateFromRepeat: false }));

  const quickDate = (offset: number | null) => {
    if (offset === null) {
      setForm((p) => ({ ...p, dueDate: "", dueTime: "", allDay: false, dateFromRepeat: false }));
      return;
    }
    setDueDate(addDaysToDateKey(todayKey(), offset));
  };

  // Turning All-day off shows the time it will use instead of keeping a
  // hidden one.
  const setAllDay = (allDay: boolean) =>
    setForm((p) => ({
      ...p,
      allDay,
      dueTime: allDay || p.dueTime ? p.dueTime : defaultTime(p.dueDate),
    }));

  // A repeat counts on from its date, so choosing one with no date picks the
  // rule's first day, and keeps following the rule until a date is chosen.
  const setRecurrence = (recurrence: RecurrenceRule | null) =>
    setForm((p) => {
      if (recurrence && (!p.dueDate || p.dateFromRepeat)) {
        return {
          ...p,
          recurrence,
          dueDate: firstOccurrenceKey(recurrence, todayKey()),
          dateFromRepeat: true,
        };
      }
      if (!recurrence && p.dateFromRepeat) {
        return { ...p, recurrence, dueDate: "", dueTime: "", dateFromRepeat: false };
      }
      return { ...p, recurrence };
    });

  const submit = async () => {
    // A repeating task needs a date to move on from, even if it was cleared.
    const filled: FormState =
      form.recurrence && !form.dueDate
        ? { ...form, dueDate: firstOccurrenceKey(form.recurrence, todayKey()) }
        : form;
    const draft = buildDraft(filled, tz);
    if (!draft.title) {
      toast.error("Give it a title first");
      return;
    }
    setSaving(true);
    try {
      if (onSubmitDraft) {
        try {
          await onSubmitDraft(draft);
        } catch {
          return; // the caller has said what went wrong; keep the edits open
        }
        onClose();
        return;
      }
      if (task) {
        const patch = changedFields(buildDraft(baseRef.current, tz), draft);
        if (!Object.keys(patch).length) {
          onClose();
          return;
        }
        const saved = await save(task.id, patch);
        if (saved) {
          onSaved?.(saved);
          onClose();
        }
        return;
      }
      const saved = await create(draft);
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
      // The server files a child in its parent's space; sending it too is harmless.
      const { task: child } = await tasksApi.create({
        title,
        parentId: task.id,
        space: task.space,
      });
      revalidate();
      if (child.parentId !== task.id) {
        toast.error("Added as a separate task, not a subtask");
        return;
      }
      setSubtasks((prev) => [...prev, child]);
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
    const index = subtasks.findIndex((s) => s.id === child.id);
    setSubtasks((prev) => prev.filter((s) => s.id !== child.id));
    try {
      await tasksApi.remove(child.id);
      revalidate();
    } catch {
      // Put it back where it was.
      setSubtasks((prev) => {
        if (prev.some((s) => s.id === child.id)) return prev;
        const at = index < 0 ? prev.length : Math.min(index, prev.length);
        return [...prev.slice(0, at), child, ...prev.slice(at)];
      });
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
                checked={isAllDay(form)}
                disabled={!form.dueDate}
                onChange={setAllDay}
              />
            </label>
          </div>
          <div className="flex gap-2">
            <input
              type="date"
              value={form.dueDate}
              onChange={(e) => setDueDate(e.target.value)}
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
          {form.dueDate ? (
            <div className="mt-2">
              <Segmented
                size="sm"
                ariaLabel="Due kind"
                value={form.dueKind}
                onChange={(v) => set("dueKind", v)}
                options={[
                  { value: "on" as const, label: "On this day" },
                  { value: "by" as const, label: "By this day" },
                ]}
              />
              {form.dueKind === "by" ? (
                <p className="mt-1.5 text-[12px] leading-snug text-muted">
                  Deadline — stays on Today every day until then, and its priority climbs as
                  the date gets close.
                </p>
              ) : null}
            </div>
          ) : null}
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

        {task?.space === "joint" ? (
          <div>
            <FieldLabel>Whose task</FieldLabel>
            <Segmented
              size="sm"
              ariaLabel="Whose task"
              value={form.assignedTo}
              onChange={(v) => set("assignedTo", v)}
              options={[
                { value: "" as const, label: "Either of us" },
                { value: myRole, label: "Me" },
                { value: theirRole, label: theirName },
              ]}
            />
          </div>
        ) : null}

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

        <div>
          <FieldLabel>Location</FieldLabel>
          <LocationField value={form.location} onChange={(loc) => set("location", loc)} />
        </div>

        <TagInput
          value={form.tags}
          onChange={(tags) => set("tags", tags)}
          suggestions={tagData?.tags ?? []}
        />

        <RecurrenceBuilder value={form.recurrence} onChange={setRecurrence} />

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
