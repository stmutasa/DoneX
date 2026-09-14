/**
 * The morning digest of the shared list.
 *
 * Each person hears about their own tasks and the ones neither of you has
 * claimed — never about the jobs the other one has taken on. Sundays are off.
 * Pure and client-safe so the rules can be tested without a clock or a model.
 */
import type { SessionRole, Task } from "@/lib/types";
import { dueLabel, isOverdue } from "@/lib/format";

export interface DigestSchedule {
  enabled: boolean;
  /** "HH:mm" local */
  time: string;
}

/** Sunday is the one morning nobody wants a list read at them. */
export const DIGEST_SKIPPED_WEEKDAY = 0;

/** "7:0" and "07:00" mean the same thing; compare them the same way. */
export function normalizeTime(value: string): string {
  const [h = "0", m = "0"] = String(value).split(":");
  const hour = Math.min(23, Math.max(0, parseInt(h, 10) || 0));
  const minute = Math.min(59, Math.max(0, parseInt(m, 10) || 0));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function isValidTime(value: string): boolean {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(value).trim());
}

/** 12-hour wording for the UI ("7:00 AM"). */
export function clockLabel(value: string): string {
  const [h, m] = normalizeTime(value).split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** Is this the minute to send, on a day we send at all? */
export function shouldSendDigest(args: {
  schedule: DigestSchedule;
  /** local "HH:mm" right now */
  nowTime: string;
  /** 0 = Sunday */
  weekday: number;
  /** local date key of today */
  today: string;
  /** the date key this person was last sent a digest, if any */
  lastSent: string | null;
}): boolean {
  const { schedule, nowTime, weekday, today, lastSent } = args;
  if (!schedule.enabled) return false;
  if (weekday === DIGEST_SKIPPED_WEEKDAY) return false;
  if (normalizeTime(nowTime) !== normalizeTime(schedule.time)) return false;
  return lastSent !== today;
}

/**
 * What this person should hear about: open shared tasks that are theirs or
 * nobody's in particular. Tasks tagged for the other person are their news to
 * get, not yours.
 */
export function tasksForPerson(tasks: Task[], role: SessionRole): Task[] {
  return tasks.filter(
    (t) =>
      t.space === "joint" &&
      t.status !== "done" &&
      !t.parentId &&
      (t.assignedTo === role || t.assignedTo === null),
  );
}

/** Split the way the digest talks about them: yours first, then shared. */
export function splitForDigest(
  tasks: Task[],
  role: SessionRole,
): { mine: Task[]; ours: Task[] } {
  const visible = tasksForPerson(tasks, role);
  return {
    mine: visible.filter((t) => t.assignedTo === role),
    ours: visible.filter((t) => t.assignedTo === null),
  };
}

/** Lines the model reads, and the fallback digest is built from. */
export function digestLines(tasks: Task[], tz: string, now?: Date): string[] {
  return tasks.slice(0, 20).map((t) => {
    const overdue = isOverdue(t.dueAt, t.allDay);
    const when = t.dueAt ? dueLabel(t.dueAt, t.allDay) : "";
    const marks = [overdue ? "OVERDUE" : "", when].filter(Boolean).join(" · ");
    return marks ? `- ${t.title} (${marks})` : `- ${t.title}`;
  });
}

/** A usable digest without a model: counts, then the nearest few titles. */
export function fallbackDigest(args: {
  mine: Task[];
  ours: Task[];
  partnerName: string;
}): string {
  const { mine, ours } = args;
  const overdue = [...mine, ...ours].filter((t) => isOverdue(t.dueAt, t.allDay)).length;

  const parts: string[] = [];
  if (mine.length) parts.push(`${mine.length} for you`);
  if (ours.length) parts.push(`${ours.length} unclaimed`);
  if (overdue) parts.push(`${overdue} overdue`);

  const head = parts.length ? parts.join(" · ") : "Nothing on the shared list";
  const titles = [...mine, ...ours].slice(0, 3).map((t) => t.title);
  return titles.length ? `${head}: ${titles.join(", ")}` : head;
}
