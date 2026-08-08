import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import {
  briefingsRepo,
  completionsRepo,
  inboxRepo,
  plansRepo,
  projectsRepo,
  reviewsRepo,
  settingsRepo,
  statsRepo,
  tasksRepo,
} from "@/lib/db/repos";
import { addDaysToDateKey, clamp, localDateKey, nowIso } from "@/lib/utils";
import type {
  Briefing,
  DayPlan,
  InboxItem,
  InboxSuggestion,
  Priority,
  Task,
  WeeklyReview,
} from "@/lib/types";
import { adapterFor, readyConfig } from "@/lib/ai/adapters";
import { buildAssistantContext } from "@/lib/ai/context";
import { asNumber, asRecord, asString, asStringArray, extractJsonObject } from "@/lib/ai/json";
import { CALL_TIMEOUT_MS, describeCallError } from "@/lib/ai/provider";
import { describeDue, instantOf, normalizePlanBlocks, utcFromLocal } from "@/lib/ai/tools";
import {
  JSON_SYSTEM,
  briefingPrompt,
  planPrompt,
  reviewPrompt,
  triagePrompt,
} from "@/lib/ai/prompts";

/** One non-streaming JSON call, with a single stricter retry on parse failure. */
async function jsonCall(prompt: string, maxTokens = 1400): Promise<Record<string, unknown>> {
  const cfg = await readyConfig();
  const adapter = adapterFor(cfg.kind);

  const ask = (text: string) =>
    adapter.complete({
      cfg,
      system: JSON_SYSTEM,
      prompt: text,
      maxTokens,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });

  let raw = "";
  try {
    raw = await ask(prompt);
  } catch (err) {
    throw new Error(describeCallError(err));
  }
  const first = extractJsonObject(raw);
  if (first) return first;

  try {
    raw = await ask(`${prompt}\n\nReturn ONLY valid JSON. No prose, no markdown fences.`);
  } catch (err) {
    throw new Error(describeCallError(err));
  }
  const second = extractJsonObject(raw);
  if (second) return second;
  throw new Error("The model did not return valid JSON.");
}

function digestLines(tasks: Task[], tz: string, limit: number): string {
  const projects = new Map(projectsRepo.list(true).map((p) => [p.id, p.name]));
  return tasks
    .slice(0, limit)
    .map((t) => {
      const bits = [`- ${t.id} · ${t.title}`];
      if (t.dueAt) bits.push(`due ${describeDue(t.dueAt, t.allDay, tz)}`);
      if (t.priority > 0) bits.push(`P${4 - t.priority}`);
      const project = t.projectId ? projects.get(t.projectId) : null;
      if (project) bits.push(project);
      return bits.join(" · ");
    })
    .join("\n");
}

// ── Briefing ───────────────────────────────────────────────────────────────

export async function generateBriefing(
  dateLocal: string,
  opts: { force?: boolean } = {}
): Promise<Briefing> {
  if (!opts.force) {
    const cached = briefingsRepo.get(dateLocal);
    if (cached) return cached;
  }

  const ctx = await buildAssistantContext();
  const tz = ctx.tz;
  const startOfToday = instantOf(utcFromLocal(dateLocal, "00:00", tz));
  const today = tasksRepo.list({ view: "today" });
  const isOverdue = (t: Task): boolean => t.dueAt !== null && instantOf(t.dueAt) < startOfToday;
  const overdue = today.filter(isOverdue);
  const dueToday = today.filter((t) => !isOverdue(t));
  const stats = statsRepo.summary();
  const yesterdayKey = addDaysToDateKey(dateLocal, -1);
  const doneYesterday = stats.week.find((d) => d.dateLocal === yesterdayKey)?.done ?? 0;

  const payload = await jsonCall(
    briefingPrompt({
      ctx,
      dateLocal,
      overdue: digestLines(overdue, tz, 12),
      dueToday: digestLines(dueToday, tz, 16),
      streak: stats.streakDays,
      doneYesterday,
    }),
    900
  );

  const known = new Set(today.map((t) => t.id));
  for (const t of tasksRepo.list({ view: "anytime" })) known.add(t.id);
  const focusTaskIds = asStringArray(payload.focusTaskIds)
    .filter((id) => known.has(id))
    .slice(0, 3);

  const briefing: Briefing = {
    dateLocal,
    greeting: (asString(payload.greeting) ?? "Good morning").trim().slice(0, 60),
    narrative: (asString(payload.narrative) ?? "").trim(),
    focusTaskIds,
    generatedAt: nowIso(),
  };
  briefingsRepo.save(briefing);
  return briefing;
}

// ── Day plan ───────────────────────────────────────────────────────────────

export async function generateDayPlan(
  dateLocal: string,
  opts: { force?: boolean } = {}
): Promise<DayPlan> {
  const cached = plansRepo.get(dateLocal);
  if (cached && !opts.force) return cached;

  const ctx = await buildAssistantContext();
  const tz = ctx.tz;
  const startOfToday = instantOf(utcFromLocal(dateLocal, "00:00", tz));
  const open = tasksRepo.list({ view: "today" });
  const isOverdue = (t: Task): boolean => t.dueAt !== null && instantOf(t.dueAt) < startOfToday;
  const ordered = [...open.filter(isOverdue), ...open.filter((t) => !isOverdue(t))];
  const briefing = briefingsRepo.get(dateLocal);

  const payload = await jsonCall(
    planPrompt({
      ctx,
      dateLocal,
      tasks: digestLines(ordered, tz, 24),
      briefing: briefing ? briefing.narrative : "",
    }),
    1600
  );

  const realIds = new Set(ordered.map((t) => t.id));
  const blocks = normalizePlanBlocks(payload.blocks).map((b) => ({
    ...b,
    taskIds: b.taskIds.filter((id) => realIds.has(id)),
  }));

  const plan: DayPlan = {
    dateLocal,
    summary: (asString(payload.summary) ?? "").trim(),
    blocks,
    accepted: false,
    generatedAt: nowIso(),
  };
  plansRepo.save(plan);
  return plan;
}

// ── Weekly review ──────────────────────────────────────────────────────────

/** Monday…Sunday date keys for an ISO week key like "2026-W32". */
export function isoWeekRange(weekKey: string): { from: string; to: string } {
  const match = /^(\d{4})-W(\d{1,2})$/.exec(weekKey.trim());
  const year = match ? Number(match[1]) : new Date().getUTCFullYear();
  const week = match ? clamp(Number(match[2]), 1, 53) : 1;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const isoDow = (jan4.getUTCDay() + 6) % 7; // Monday = 0
  const week1Monday = jan4.getTime() - isoDow * 86_400_000;
  const monday = new Date(week1Monday + (week - 1) * 7 * 86_400_000);
  const sunday = new Date(monday.getTime() + 6 * 86_400_000);
  return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
}

export async function generateWeeklyReview(
  weekKey: string,
  opts: { force?: boolean } = {}
): Promise<WeeklyReview> {
  if (!opts.force) {
    const cached = reviewsRepo.get(weekKey);
    if (cached) return cached;
  }

  const tz = settingsRepo.getApp().tz;
  const { from, to } = isoWeekRange(weekKey);
  const completions = completionsRepo.listRange(from, to);
  const byDay = completionsRepo.countsByDay(from, to);
  const stats = statsRepo.summary();
  const counts = tasksRepo.counts();

  const createdCount = tasksRepo
    .list({ includeDone: true })
    .filter((t) => {
      const key = localDateKey(t.createdAt, tz);
      return key >= from && key <= to;
    }).length;

  const perDayLines: string[] = [];
  let computedBest: string | null = null;
  let bestCount = 0;
  for (let i = 0; i < 7; i++) {
    const key = addDaysToDateKey(from, i);
    const done = byDay.get(key) ?? 0;
    const label = format(new TZDate(new Date(`${key}T12:00:00Z`), "UTC"), "EEE");
    perDayLines.push(`- ${key} (${label}): ${done}`);
    if (done > bestCount) {
      bestCount = done;
      computedBest = key;
    }
  }

  const completedList = completions
    .slice(-40)
    .map((c) => `- ${c.dateLocal} · ${c.title}`)
    .join("\n");

  const payload = await jsonCall(
    reviewPrompt({
      weekKey,
      range: `${from} → ${to}`,
      completed: completedList,
      perDay: perDayLines.join("\n"),
      completedCount: completions.length,
      createdCount,
      streak: stats.streakDays,
      openNow: counts.open,
      overdueNow: counts.overdue,
    }),
    1000
  );

  const modelBest = asString(payload.bestDay)?.trim() ?? "";
  const bestDay = /^\d{4}-\d{2}-\d{2}$/.test(modelBest) && modelBest >= from && modelBest <= to
    ? modelBest
    : computedBest;

  const review: WeeklyReview = {
    weekKey,
    completedCount: completions.length,
    createdCount,
    streak: stats.streakDays,
    bestDay,
    narrative: (asString(payload.narrative) ?? "").trim(),
    suggestions: asStringArray(payload.suggestions)
      .map((s) => s.replace(/^[-*•]\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 4),
    generatedAt: nowIso(),
  };
  reviewsRepo.save(review);
  return review;
}

// ── Inbox triage ───────────────────────────────────────────────────────────

function parseLocalDue(raw: unknown, tz: string): { dueAt: string | null; allDay: boolean } {
  const value = asString(raw)?.trim() ?? "";
  if (!value || /^(null|none)$/i.test(value)) return { dueAt: null, allDay: false };
  const withTime = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})/.exec(value);
  if (withTime) {
    const hh = String(clamp(Number(withTime[2]), 0, 23)).padStart(2, "0");
    return { dueAt: utcFromLocal(withTime[1], `${hh}:${withTime[3]}`, tz), allDay: false };
  }
  const dateOnly = /^(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (dateOnly) return { dueAt: utcFromLocal(dateOnly[1], "00:00", tz), allDay: true };
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return { dueAt: null, allDay: false };
  return { dueAt: parsed.toISOString(), allDay: false };
}

export async function triageInboxItem(id: string): Promise<InboxItem> {
  const item = inboxRepo.get(id);
  if (!item) throw new Error("Inbox item not found");

  const tz = settingsRepo.getApp().tz;
  const now = new Date();
  const todayKey = localDateKey(now, tz);

  const payload = await jsonCall(
    triagePrompt({
      content: item.content,
      fromLabel: item.fromLabel,
      source: item.source,
      receivedAt: item.receivedAt,
      todayKey,
      weekday: format(new TZDate(now, tz), "EEEE"),
      tz,
    }),
    600
  );

  const actionRaw = asString(payload.action)?.toLowerCase().trim();
  const action: InboxSuggestion["action"] =
    actionRaw === "task" || actionRaw === "note" ? actionRaw : "ignore";

  const suggestion: InboxSuggestion = {
    action,
    reason: (asString(payload.reason) ?? "").trim().slice(0, 90),
  };

  if (action === "task") {
    const taskRec = asRecord(payload.task) ?? {};
    const title = (asString(taskRec.title) ?? item.content).trim().slice(0, 80);
    const due = parseLocalDue(taskRec.dueAtLocal ?? taskRec.dueAt, tz);
    const priorityNum = asNumber(taskRec.priority) ?? 0;
    suggestion.task = {
      title: title || item.content.slice(0, 80),
      dueAt: due.dueAt,
      allDay: due.allDay,
      priority: clamp(Math.round(priorityNum), 0, 3) as Priority,
    };
  } else if (action === "note") {
    const noteRec = asRecord(payload.note) ?? {};
    suggestion.note = {
      title: (asString(noteRec.title) ?? "Captured note").trim().slice(0, 80) || "Captured note",
      content: (asString(noteRec.content) ?? item.content).trim(),
    };
  }

  inboxRepo.setSuggestion(id, suggestion);
  return inboxRepo.get(id) ?? { ...item, suggestion };
}
