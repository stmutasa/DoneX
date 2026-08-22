import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import {
  briefingsRepo,
  completionsRepo,
  feedbackRepo,
  inboxRepo,
  plansRepo,
  projectsRepo,
  reviewsRepo,
  settingsRepo,
  statsRepo,
  tasksRepo,
} from "@/lib/db/repos";
import { addDaysToDateKey, clamp, localDateKey, nowIso } from "@/lib/utils";
import { deadlineLabel, effectivePriority } from "@/lib/deadline";
import type {
  Briefing,
  DayPlan,
  TaskDraft,
  InboxItem,
  InboxSuggestion,
  Priority,
  Task,
  TriageFeedback,
  WeeklyReview,
} from "@/lib/types";
import { PRIORITY_META } from "@/lib/types";
import { callWithFailover } from "@/lib/ai/adapters";
import { buildAssistantContext, buildTaskDigest } from "@/lib/ai/context";
import { asArray, asNumber, asRecord, asString, asStringArray, extractJsonObject } from "@/lib/ai/json";
import { CALL_TIMEOUT_MS, describeCallError } from "@/lib/ai/provider";
import { describeDue, instantOf, normalizePlanBlocks, utcFromLocal } from "@/lib/ai/tools";
import {
  JSON_SYSTEM,
  breakdownPrompt,
  briefingPrompt,
  planPrompt,
  reviewPrompt,
  triagePrompt,
} from "@/lib/ai/prompts";

/** One non-streaming JSON call, with a single stricter retry on parse failure. */
async function jsonCall(prompt: string, maxTokens = 1400): Promise<Record<string, unknown>> {
  // Wrapped in failover: a dead key, a rate limit or a model that simply
  // cannot produce JSON all hand off to the standby provider.
  return callWithFailover(async (cfg, adapter) => {
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
  });
}

function digestLines(tasks: Task[], tz: string, limit: number): string {
  const projects = new Map(projectsRepo.list(true).map((p) => [p.id, p.name]));
  return tasks
    .slice(0, limit)
    .map((t) => {
      const bits = [`- ${t.id} · ${t.title}`];
      if (t.dueAt) {
        bits.push(
          t.dueKind === "by"
            ? deadlineLabel(t.dueAt, tz)
            : `due ${describeDue(t.dueAt, t.allDay, tz)}`
        );
      }
      const p = effectivePriority(t, tz);
      if (p > 0) bits.push(`P${4 - p}${p > t.priority ? " (escalated)" : ""}`);
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
      weather: await safeWeatherLine(tz),
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
  // Anytime tasks are candidates too — the planner picks a few worth doing today.
  const anytime = tasksRepo
    .list({ view: "anytime" })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, 12);
  const briefing = briefingsRepo.get(dateLocal);

  const payload = await jsonCall(
    planPrompt({
      ctx,
      dateLocal,
      tasks: digestLines(ordered, tz, 24),
      anytime: digestLines(anytime, tz, 12),
      briefing: briefing ? briefing.narrative : "",
    }),
    1800
  );

  const realIds = new Set([...ordered, ...anytime].map((t) => t.id));
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

// ── Paragraph → tasks (project breakdown) ─────────────────────────────────

export interface BreakdownItem {
  title: string;
  notes: string;
  dueAtLocal: string | null;
  dueKind: "on" | "by";
  priority: Priority;
  tags: string[];
}

/** Pure normalization of the model's breakdown JSON — malformed entries are
 *  dropped rather than guessed at, and everything is clamped to app limits. */
export function parseBreakdown(payload: Record<string, unknown>): BreakdownItem[] {
  const out: BreakdownItem[] = [];
  for (const entry of asArray(payload.tasks)) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const title = (asString(rec.title) ?? "").trim().replace(/[.!,;:]+$/, "").slice(0, 80);
    if (!title) continue;
    const priorityNum = asNumber(rec.priority) ?? 0;
    out.push({
      title,
      notes: (asString(rec.notes) ?? "").trim().slice(0, 200),
      dueAtLocal: asString(rec.dueAtLocal ?? rec.dueAt) ?? null,
      dueKind: asString(rec.dueKind)?.toLowerCase() === "by" ? "by" : "on",
      priority: clamp(Math.round(priorityNum), 0, 3) as Priority,
      tags: (asStringArray(rec.tags) ?? [])
        .map((t) => t.trim().toLowerCase().replace(/^#/, ""))
        .filter(Boolean)
        .slice(0, 2),
    });
    if (out.length === 20) break;
  }
  return out;
}

/**
 * Turn a pasted paragraph into proposed TaskDrafts for one project. Proposes
 * only — nothing is created here; the user picks which drafts to keep and the
 * client files them through the normal task API.
 */
export async function generateTaskBreakdown(
  text: string,
  projectId: string,
): Promise<TaskDraft[]> {
  const settings = settingsRepo.getApp();
  const tz = settings.tz;
  const now = new Date();
  const project = projectsRepo.get(projectId);
  const existing = tasksRepo
    .list({ projectId })
    .slice(0, 30)
    .map((t) => `- ${t.title}`)
    .join("\n");

  const payload = await jsonCall(
    breakdownPrompt({
      text,
      projectName: project?.name ?? "their project",
      todayKey: localDateKey(now, tz),
      weekday: format(new TZDate(now, tz), "EEEE"),
      tz,
      existingTasks: existing,
    }),
    1800,
  );

  return parseBreakdown(payload).map((item) => {
    const due = parseLocalDue(item.dueAtLocal, tz);
    return {
      title: item.title,
      notes: item.notes,
      priority: item.priority,
      dueAt: due.dueAt,
      dueKind: due.dueAt ? item.dueKind : "on",
      allDay: due.allDay,
      projectId,
      tags: item.tags,
    };
  });
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

export type TriageDecision = "task" | "note" | "dismiss" | "duplicate" | "update";

export interface ParsedTriage {
  decision: TriageDecision;
  reason: string;
  duplicateOf: string;
  update: {
    taskTitle: string;
    dueAtLocal: string | null;
    priority: Priority | null;
    note: string;
  } | null;
  task: {
    title: string;
    dueAtLocal: string | null;
    dueKind: "on" | "by";
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
    raw === "note" || raw === "dismiss" || raw === "duplicate" || raw === "update" || raw === "ignore"
      ? raw === "ignore"
        ? "dismiss"
        : (raw as TriageDecision)
      : "task";

  const reason = (asString(payload.reason) ?? "").trim().slice(0, 90);
  const duplicateOf = (asString(payload.duplicateOf) ?? "").trim().slice(0, 120);

  let update: ParsedTriage["update"] = null;
  if (decision === "update") {
    const rec = asRecord(payload.update) ?? {};
    const priorityNum = asNumber(rec.priority);
    update = {
      taskTitle: (asString(rec.taskTitle) ?? "").trim().slice(0, 120),
      dueAtLocal: asString(rec.dueAtLocal ?? rec.dueAt) ?? null,
      priority:
        priorityNum === null ? null : (clamp(Math.round(priorityNum), 0, 3) as Priority),
      note: (asString(rec.note) ?? "").trim().slice(0, 200),
    };
  }

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
      dueKind: asString(rec.dueKind)?.toLowerCase() === "by" ? "by" : "on",
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

  return { decision, reason, duplicateOf, update, task, note };
}

/** Weather for the briefing, keyed off the last client-reported position
 *  (< 24h old). Imported lazily: the weather module is server-only. */
async function safeWeatherLine(tz: string): Promise<string> {
  try {
    const last = settingsRepo.getApp().lastLocation;
    if (!last) return "";
    const age = Date.now() - Date.parse(last.at);
    if (!Number.isFinite(age) || age > 24 * 60 * 60 * 1000) return "";
    const { todayWeatherLine } = await import("@/lib/weather");
    return await todayWeatherLine(last.lat, last.lng, tz);
  } catch {
    return "";
  }
}

/**
 * The user's corrections, formatted for the triage prompt. Pure so it can be
 * unit-tested; newest lessons first, capped per side.
 */
export function buildFeedbackDigest(entries: TriageFeedback[], perSide = 8): string {
  const line = (f: TriageFeedback) =>
    `- "${f.reason}" (about: "${f.content.slice(0, 70)}"${f.fromLabel ? ` from ${f.fromLabel}` : ""})`;
  const kept = entries.filter((f) => f.kind === "should_have_kept").slice(0, perSide);
  const dismissed = entries.filter((f) => f.kind === "dismiss_because").slice(0, perSide);
  if (kept.length === 0 && dismissed.length === 0) return "";
  const parts: string[] = [];
  if (kept.length) {
    parts.push(
      `Wrongly dismissed in the past — the user said these should have been KEPT. Lean keep for anything similar:\n${kept.map(line).join("\n")}`
    );
  }
  if (dismissed.length) {
    parts.push(
      `The user personally dismissed these, in their own words. Lean dismiss for anything similar:\n${dismissed.map(line).join("\n")}`
    );
  }
  return parts.join("\n\n");
}

/** Sent-mail context, imported lazily: the Google module is server-only. */
async function safeSentDigest(): Promise<string> {
  try {
    const { recentSentDigest } = await import("@/lib/google/sent");
    return await recentSentDigest();
  } catch {
    return "";
  }
}

function appendUpdateNote(existing: string, addition: string, todayKey: string): string {
  const stamp = `Update (${todayKey}): ${addition}`;
  return (existing ? `${existing.trimEnd()}\n\n${stamp}` : stamp).slice(0, 2000);
}

/**
 * Triage decides AND acts: clearly-irrelevant or already-tracked GMAIL items
 * are dismissed on the spot; items carrying NEW info about an open task update
 * that task directly. The verdict is stored first, so History always shows
 * why. Items the user captured themselves (sms/quick) are never auto-closed
 * without an action being taken — a dismiss verdict just becomes an "ignore"
 * suggestion they can act on.
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
      sentDigest: await safeSentDigest(),
      feedbackDigest: buildFeedbackDigest(feedbackRepo.list(30)),
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
      dueKind: due.dueAt ? parsed.task.dueKind : "on",
      allDay: due.allDay,
      priority: parsed.task.priority,
      projectId: project?.id ?? null,
      tags: parsed.task.tags,
    };
  } else if (parsed.decision === "note" && parsed.note) {
    suggestion.action = "note";
    suggestion.note = { ...parsed.note, content: parsed.note.content || item.content };
  } else if (parsed.decision === "update" && parsed.update) {
    const wanted = parsed.update.taskTitle.toLowerCase();
    const target = tasksRepo
      .list({ view: "all" })
      .find((t) => t.title.toLowerCase() === wanted);

    if (target) {
      const changes: string[] = [];
      const patch: Record<string, unknown> = {};
      if (parsed.update.dueAtLocal) {
        const due = parseLocalDue(parsed.update.dueAtLocal, tz);
        if (due.dueAt && due.dueAt !== target.dueAt) {
          patch.dueAt = due.dueAt;
          patch.allDay = due.allDay;
          changes.push(`due ${describeDue(due.dueAt, due.allDay, tz)}`);
        }
      }
      if (parsed.update.priority !== null && parsed.update.priority !== target.priority) {
        patch.priority = parsed.update.priority;
        changes.push(`priority ${PRIORITY_META[parsed.update.priority].short}`);
      }
      if (parsed.update.note) {
        patch.notes = appendUpdateNote(target.notes, parsed.update.note, todayKey);
        if (changes.length === 0) changes.push("added a note");
      }
      if (Object.keys(patch).length > 0) tasksRepo.update(target.id, patch);

      suggestion.updatedTaskTitle = target.title;
      suggestion.reason = `Updated “${target.title}”${changes.length ? ` — ${changes.join(", ")}` : ""}`.slice(0, 90);
      inboxRepo.setSuggestion(id, suggestion);
      inboxRepo.resolve(id, "resolved", target.id);
      return inboxRepo.get(id) ?? { ...item, suggestion };
    }

    // Couldn't match the task the model named — keep the item visible.
    suggestion.reason =
      suggestion.reason || `Mentions “${parsed.update.taskTitle}” but no open task matches`;
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

/**
 * Closes out gmail items that already carry a "nothing to do here" verdict but
 * were left sitting in the inbox (pre-1.2 triage, or older failures). Returns
 * how many it swept.
 */
export function sweepAutoDismissable(): number {
  const stale = inboxRepo
    .list({ status: "new" })
    .filter((i) => i.source === "gmail" && i.suggestion?.action === "ignore");
  for (const item of stale) {
    inboxRepo.setSuggestion(item.id, { ...item.suggestion!, autoDismissed: true });
    inboxRepo.resolve(item.id, "dismissed");
  }
  return stale.length;
}
