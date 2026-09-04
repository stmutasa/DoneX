/**
 * Tagging a shared task with the person who should do it.
 *
 * The alert is worth sending only when it tells someone something they don't
 * already know: the task has to be on the shared list, aimed at the other
 * person, and newly aimed there — reassigning to the same person, or tagging
 * yourself, is silent. Kept pure so the rules are testable and the routes stay
 * thin. Client-safe.
 */
import type { SessionRole, Task } from "@/lib/types";

export interface AssignmentAlert {
  /** the role to notify */
  to: SessionRole;
  title: string;
  body: string;
  url: string;
  tag: string;
}

export interface PeopleNames {
  owner: string;
  partner: string;
}

export function nameFor(role: SessionRole, names: PeopleNames): string {
  const raw = role === "partner" ? names.partner : names.owner;
  return raw.trim() || (role === "partner" ? "Your partner" : "Someone");
}

export function assignmentAlert(args: {
  task: Pick<Task, "id" | "title" | "space" | "assignedTo">;
  /** who made the change */
  actor: SessionRole;
  /** who it was assigned to before — omit for a brand new task */
  previous?: SessionRole | null;
  names: PeopleNames;
}): AssignmentAlert | null {
  const { task, actor, previous = null, names } = args;
  const to = task.assignedTo;

  if (task.space !== "joint") return null;
  if (!to) return null;
  // Picking something up yourself isn't news to you.
  if (to === actor) return null;
  if (to === previous) return null;

  return {
    to,
    title: `${nameFor(actor, names)} tagged you`,
    body: task.title.slice(0, 120),
    url: "/joint",
    tag: `joint-assign-${task.id}`,
  };
}
