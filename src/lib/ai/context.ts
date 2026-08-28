import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import { projectsRepo, settingsRepo, statsRepo, tasksRepo } from "@/lib/db/repos";
import { addDaysToDateKey, localDateKey, localTimeKey } from "@/lib/utils";
import { deadlineLabel, effectivePriority } from "@/lib/deadline";
import type { CalendarEvent, StatsSummary, Task } from "@/lib/types";
import { describeDue, instantOf, utcFromLocal } from "@/lib/ai/tools";

const MAX_DIGEST_LINES = 40;

export interface AssistantContext {
  tz: string;
  todayKey: string;
  weekday: string;
  dateLabel: string;
  timeLabel: string;
  taskDigest: string;
  projectList: string;
  calendarList: string;
  statsLine: string;
}

export function taskLine(task: Task, tz: string, projects: Map<string, string>): string {
  const bits = [`- ${task.id} · ${task.title}`];
  if (task.dueAt) {
    bits.push(
      task.dueKind === "by"
        ? deadlineLabel(task.dueAt, tz)
        : `due ${describeDue(task.dueAt, task.allDay, tz)}`
    );
  }
  const p = effectivePriority(task, tz);
  if (p > 0) bits.push(`P${4 - p}${p > task.priority ? " (escalated)" : ""}`);
  const project = task.projectId ? projects.get(task.projectId) : null;
  if (project) bits.push(project);
  if (task.tags.length > 0) bits.push(task.tags.map((t) => `#${t}`).join(" "));
  return bits.join(" · ");
}

export function buildTaskDigest(tz: string, todayKey: string): string {
  const projects = new Map(projectsRepo.list(true).map((p) => [p.id, p.name]));
  const startOfToday = instantOf(utcFromLocal(todayKey, "00:00", tz));
  const weekEnd = instantOf(utcFromLocal(addDaysToDateKey(todayKey, 8), "00:00", tz));

  const todayTasks = tasksRepo.list({ view: "today" });
  const todayIds = new Set(todayTasks.map((t) => t.id));
  const isOverdue = (t: Task): boolean => t.dueAt !== null && instantOf(t.dueAt) < startOfToday;
  const overdue = todayTasks.filter(isOverdue);
  const dueToday = todayTasks.filter((t) => !isOverdue(t));
  const upcoming = tasksRepo
    .list({ view: "upcoming" })
    .filter((t) => !todayIds.has(t.id) && t.dueAt !== null && instantOf(t.dueAt) < weekEnd);
  const anytime = tasksRepo.list({ view: "anytime" });
  const joint = tasksRepo.list({ space: "joint" });

  const sections: { heading: string; tasks: Task[]; cap: number }[] = [
    { heading: "OVERDUE", tasks: overdue, cap: 10 },
    { heading: "ON TODAY'S LIST (due today + live deadlines)", tasks: dueToday, cap: 14 },
    { heading: "NEXT 7 DAYS", tasks: upcoming, cap: 12 },
    { heading: "ANYTIME (no date)", tasks: anytime, cap: 8 },
    { heading: "JOINT LIST (shared with the partner)", tasks: joint, cap: 8 },
  ];

  const lines: string[] = [];
  let budget = MAX_DIGEST_LINES;
  for (const section of sections) {
    if (section.tasks.length === 0 || budget <= 0) continue;
    const take = Math.min(section.cap, budget, section.tasks.length);
    lines.push(`${section.heading} (${section.tasks.length})`);
    for (const task of section.tasks.slice(0, take)) {
      lines.push(taskLine(task, tz, projects));
    }
    if (section.tasks.length > take) lines.push(`- …${section.tasks.length - take} more`);
    budget -= take;
  }

  return lines.length > 0 ? lines.join("\n") : "No open tasks.";
}

export function buildProjectList(): string {
  const projects = projectsRepo.list();
  if (projects.length === 0) return "No projects yet.";
  return projects
    .slice(0, 25)
    .map((p) => `- ${p.id} · ${p.name}${p.openCount ? ` (${p.openCount} open)` : ""}`)
    .join("\n");
}

export function buildCalendarList(events: CalendarEvent[], tz: string): string {
  if (events.length === 0) return "No calendar events today (or calendar not connected).";
  return events
    .slice(0, 15)
    .map((e) => {
      if (e.allDay) return `- all day · ${e.title}`;
      const start = format(new TZDate(new Date(e.start), tz), "HH:mm");
      const end = format(new TZDate(new Date(e.end), tz), "HH:mm");
      return `- ${start}–${end} · ${e.title}${e.location ? ` (${e.location})` : ""}`;
    })
    .join("\n");
}

export function buildStatsLine(stats: StatsSummary): string {
  return `${stats.today.done} done today · ${stats.today.open} on today's list · ${stats.totalOpen} open overall · ${stats.overdue} overdue · ${stats.streakDays}-day streak`;
}

export async function safeTodayEvents(): Promise<CalendarEvent[]> {
  try {
    // Imported lazily: the Google module is server-only, this one is not.
    const { getTodayEvents } = await import("@/lib/google/calendar");
    return await getTodayEvents();
  } catch {
    return [];
  }
}

export async function buildAssistantContext(): Promise<AssistantContext> {
  const tz = settingsRepo.getApp().tz;
  const now = new Date();
  const todayKey = localDateKey(now, tz);
  const zoned = new TZDate(now, tz);
  const events = await safeTodayEvents();

  return {
    tz,
    todayKey,
    weekday: format(zoned, "EEEE"),
    dateLabel: format(zoned, "EEEE, d MMMM yyyy"),
    timeLabel: localTimeKey(now, tz),
    taskDigest: buildTaskDigest(tz, todayKey),
    projectList: buildProjectList(),
    calendarList: buildCalendarList(events, tz),
    statsLine: buildStatsLine(statsRepo.summary()),
  };
}
