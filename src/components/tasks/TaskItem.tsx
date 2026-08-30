"use client";

import { useEffect, useState } from "react";
import type { Project, Task } from "@/lib/types";
import { PRIORITY_META } from "@/lib/types";
import { hueSoftVar, hueVar, normalizeJointColor } from "@/lib/jointColors";
import { deadlineChip, dueLabel, isOverdue } from "@/lib/format";
import { effectivePriority } from "@/lib/deadline";
import { cn } from "@/lib/utils";
import {
  IconChevronRight,
  IconCheck,
  IconFlag,
  IconMapPin,
  IconRepeat,
} from "@/components/ui/icons";
import { ProgressRing } from "@/components/ui/Misc";
import { useTaskMutations } from "./useTaskMutations";

const PRIORITY_TONE: Record<1 | 2 | 3, string> = {
  3: "text-warn",
  2: "text-accent",
  1: "text-faint",
};

export function TaskItem({
  task,
  project,
  onOpen,
  showProject = true,
  attribution,
}: {
  task: Task;
  project?: Project;
  onOpen?: (task: Task) => void;
  showProject?: boolean;
  /** joint list: names to attribute tasks to, tinted with their chosen color */
  attribution?: { owner: string; partner: string; colors?: { owner?: string; partner?: string } };
}) {
  const { complete } = useTaskMutations();
  const [done, setDone] = useState(task.status === "done");
  const [popping, setPopping] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDone(task.status === "done"), [task.status]);

  const subtasks = task.subtasks ?? [];
  const doneSubs = subtasks.filter((s) => s.status === "done").length;
  const overdue = !done && isOverdue(task.dueAt, task.allDay);
  const isDeadline = task.dueKind === "by" && !!task.dueAt;
  const label = task.dueAt
    ? isDeadline && !overdue
      ? deadlineChip(task.dueAt)
      : dueLabel(task.dueAt, task.allDay)
    : "";
  const priority = done
    ? task.priority
    : effectivePriority(task, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const escalated = priority > task.priority;
  const byPartner = task.createdBy === "partner";
  const attributionColor = attribution
    ? normalizeJointColor(
        byPartner ? attribution.colors?.partner : attribution.colors?.owner,
        byPartner ? "pink" : "blue",
      )
    : null;

  const toggle = async () => {
    if (busy) return;
    const next = !done;
    setBusy(true);
    setDone(next);
    if (next) {
      setPopping(true);
      window.setTimeout(() => setPopping(false), 340);
    }
    const ok = await complete(task, next);
    if (!ok) setDone(!next);
    setBusy(false);
  };

  return (
    <div
      className={cn(
        "group flex items-start gap-3 rounded-2xl border border-stroke bg-elev px-3 py-3 transition-colors lg:py-2.5",
        "hover:border-stroke-strong",
        done && "opacity-70",
      )}
    >
      <button
        type="button"
        onClick={toggle}
        aria-label={done ? `Mark “${task.title}” as not done` : `Complete “${task.title}”`}
        aria-pressed={done}
        className="-m-2 grid h-11 w-11 shrink-0 place-items-center rounded-full"
      >
        <span
          className={cn(
            "grid h-[25px] w-[25px] place-items-center rounded-full border-2 transition-colors duration-200",
            done ? "border-transparent bg-sunrise text-on-accent" : "border-stroke-strong text-transparent",
            overdue && !done && "border-danger",
            popping && "animate-check-pop",
          )}
        >
          <IconCheck className="h-3.5 w-3.5" strokeWidth={3} />
        </span>
      </button>

      <button
        type="button"
        onClick={() => onOpen?.(task)}
        className="min-w-0 flex-1 text-left"
        aria-label={`Edit ${task.title}`}
      >
        <div className={cn("text-[15px] leading-snug text-ink", done && "task-done-title")}>
          {task.title}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12px] text-muted">
          {label ? (
            <span
              className={cn(
                "inline-flex items-center gap-1",
                overdue && "font-medium text-danger",
                !overdue && isDeadline && escalated && "font-medium text-warn",
              )}
            >
              {label}
            </span>
          ) : null}

          {task.recurrence ? (
            <span className="inline-flex items-center gap-0.5 text-faint" title="Repeats">
              <IconRepeat className="h-3 w-3" />
            </span>
          ) : null}

          {showProject && project ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: project.color }}
                aria-hidden="true"
              />
              {project.icon} {project.name}
            </span>
          ) : null}

          {task.location ? (
            <span className="inline-flex items-center gap-1">
              <IconMapPin className="h-3 w-3" />
              {task.location.name}
            </span>
          ) : null}

          {task.tags.slice(0, 3).map((t) => (
            <span key={t} className="text-faint">
              #{t}
            </span>
          ))}

          {attribution && attributionColor ? (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
              style={{ background: hueSoftVar(attributionColor), color: hueVar(attributionColor) }}
            >
              {byPartner ? attribution.partner : attribution.owner}
            </span>
          ) : null}

          {priority > 0 ? (
            <span
              className={cn(
                "inline-flex items-center gap-0.5 font-medium",
                PRIORITY_TONE[priority as 1 | 2 | 3],
              )}
              title={
                escalated
                  ? `${PRIORITY_META[priority].label} — escalated, deadline approaching`
                  : PRIORITY_META[priority].label
              }
            >
              <IconFlag className="h-3 w-3" />
              {PRIORITY_META[priority].short}
              {escalated ? "↑" : ""}
            </span>
          ) : null}

          {subtasks.length ? (
            <span className="inline-flex items-center gap-1 text-faint">
              <ProgressRing value={doneSubs} total={subtasks.length} size={13} stroke={2} />
              {doneSubs}/{subtasks.length}
            </span>
          ) : null}
        </div>
      </button>

      <span
        aria-hidden="true"
        className="mt-1 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100"
      >
        <IconChevronRight className="h-4 w-4" />
      </span>
    </div>
  );
}
