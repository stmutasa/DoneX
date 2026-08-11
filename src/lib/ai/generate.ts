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
import { buildAssistantContext, buildTaskDigest } from "@/lib/ai/context";
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

export type TriageDecision = "task" | "note" | "dismiss" | "duplicate";

export interface ParsedTriage {
  decision: TriageDecision;
  reason: string;
  duplicateOf: string;
  task: {
    title: string;
    dueAtLocal: string | null;
    priority: Priority;
    projectName: string | null;
    tags: string[];
  } | null;
  note: { title: string; content: string } | null;
}

/** Pure normalization of the model's triage JSON; unknown decisions fall back
 *  to "task" so nothing actionable is ever thrown away by a formatting slip. */
export function parseTriageDecision(
  payload: Record<string, unknown>,
  fallbackTitle: string,
): ParsedTriage {
  const raw = asString(payload.decision ?? payload.action)?.toLowerCase().trim() ?? "";
  const decision: TriageDecision =
    raw === "note" || raw === "dismiss" || raw === "duplicate" || raw === "ignore"
      ? raw === "ignore"
        ? "dismiss"
        : (raw as TriageDecision)
      : "task";

  const reason = (asString(payload.reason) ?? "").trim().slice(0, 90);
  const duplicateOf = (asString(payload.duplicateOf) ?? "").trim().slice(0, 120);

  let task: ParsedTriage["task"] = null;
  if (decision === "task") {
    const rec = asRecord(payload.task) ?? {};
    const title = (asString(rec.title) ?? "").trim().slice(0, 80) || fallbackTitle.slice(0, 80);
    const priorityNum = asNumber(rec.priority) ?? 0;
    const tags = (asStringArray(rec.tags) ?? [])
      .map((t) => t.trim().toLowerCase().replace(/^#/, ""))
      .filter(Boolean)
      .slice(0, 3);
    task = {
      title,
      dueAtLocal: asString(rec.dueAtLocal ?? rec.dueAt) ?? null,
      priority: clamp(Math.round(priorityNum), 0, 3) as Priority,
      projectName: (asString(rec.projectName) ?? "").trim() || null,
      tags,
    };
  }

  let note: ParsedTriage["note"] = null;
  if (decision === "note") {
    const rec = asRecord(payload.note) ?? {};
    note = {
      title: (asString(rec.title) ?? "Captured note").trim().slice(0, 80) || "Captured note",
      content: (asString(rec.content) ?? "").trim(),
    };
  }

  return { decision, reason, duplicateOf, task, note };
}

/**
 * Triage decides AND acts: clearly-irrelevant or already-tracked GMAIL items
 * are dismissed on the spot (the suggestion is stored first, so History shows
 * why). Items the user captured themselves (sms/quick) are never auto-closed —
 * a dismiss verdict just becomes an "ignore" suggestion they can act on.
 */
export async function triageInboxItem(id: string): Promise<InboxItem> {
  const item = inboxRepo.get(id);
  if (!item) throw new Error("Inbox item not found");

  const tz = settingsRepo.getApp().tz;
  const now = new Date();
  const todayKey = localDateKey(now, tz);
  const projects = projectsRepo.list();

  const payload = await jsonCall(
    triagePrompt({
      content: item.content,
      fromLabel: item.fromLabel,
      source: item.source,
      receivedAt: item.receivedAt,
      todayKey,
      weekday: format(new TZDate(now, tz), "EEEE"),
      tz,
      openTasksDigest: buildTaskDigest(tz, todayKey),
      projectNames: projects.map((p) => p.name),
      tags: tasksRepo.allTags().slice(0, 20),
    }),
    700
  );

  const parsed = parseTriageDecision(payload, item.content);
  const suggestion: InboxSuggestion = { action: "ignore", reason: parsed.reason };

  if (parsed.decision === "task" && parsed.task) {
    const due = parseLocalDue(parsed.task.dueAtLocal, tz);
    const project = parsed.task.projectName
      ? projects.find((p) => p.name.toLowerCase() === parsed.task!.projectName!.toLowerCase())
      : undefined;
    suggestion.action = "task";
    suggestion.task = {
      title: parsed.task.title,
      dueAt: due.dueAt,
      allDay: due.allDay,
      priority: parsed.task.priority,
      projectId: project?.id ?? null,
      tags: parsed.task.tags,
    };
  } else if (parsed.decision === "note" && parsed.note) {
    suggestion.action = "note";
    suggestion.note = { ...parsed.note, content: parsed.note.content || item.content };
  } else {
    // dismiss / duplicate
    if (parsed.decision === "duplicate" && parsed.duplicateOf) {
      suggestion.duplicateOfTitle = parsed.duplicateOf;
      if (!suggestion.reason) suggestion.reason = `Already tracked: ${parsed.duplicateOf}`;
    }
    if (item.source === "gmail") suggestion.autoDismissed = true;
  }

  inboxRepo.setSuggestion(id, suggestion);
  if (suggestion.autoDismissed) inboxRepo.resolve(id, "dismissed");
  return inboxRepo.get(id) ?? { ...item, suggestion };
}
