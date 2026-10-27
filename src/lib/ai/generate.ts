import { TZDate } from "@date-fns/tz";
import { format } from "date-fns";
import {
  briefingsRepo,
  completionsRepo,
  feedbackRepo,
  inboxRepo,
  projectsRepo,
  reviewsRepo,
  settingsRepo,
  statsRepo,
  tasksRepo,
} from "@/lib/db/repos";
import { getDb } from "@/lib/db";
import { addDaysToDateKey, clamp, isoFromLocal, localDateKey, localTimeKey, nowIso } from "@/lib/utils";
import { deadlineLabel, effectivePriority } from "@/lib/deadline";
import { composeInboxNotes } from "@/lib/inboxNotes";
import {
  normalizeLocalDue,
  readBasis,
  settleDeadline,
  settlePriority,
  type DeadlineBasis,
} from "@/lib/triageDeadline";
import { waitingLines, waitingOn } from "@/lib/nudges";
import {
  digestLines as digestLinesFor,
  fallbackDigest,
  splitForDigest,
} from "@/lib/jointDigest";
import {
  contextLines,
  fallbackWeekAhead,
  weekAheadContext,
  worthSending,
} from "@/lib/weekAhead";
import type { AiFeature } from "@/lib/ai/usage";
import type {
  Briefing,
  CalendarEvent,
  TaskDraft,
  InboxItem,
  InboxSuggestion,
  Priority,
  SessionRole,
  Task,
  TriageFeedback,
  WeeklyReview,
} from "@/lib/types";
import { PRIORITY_META } from "@/lib/types";
import { aiConfigured, callWithFailover } from "@/lib/ai/adapters";
import {
  buildAssistantContext,
  buildCalendarList,
  buildTaskDigest,
  safeEventsBetween,
  type AssistantContext,
} from "@/lib/ai/context";
import { asArray, asNumber, asRecord, asString, asStringArray, extractJsonObject } from "@/lib/ai/json";
import { CALL_TIMEOUT_MS, describeCallError } from "@/lib/ai/provider";
import { describeDue, instantOf, utcFromLocal } from "@/lib/ai/tools";
import {
  JSON_SYSTEM,
  breakdownPrompt,
  briefingPrompt,
  jointDigestPrompt,
  weekAheadPrompt,
  reviewPrompt,
  triagePrompt,
} from "@/lib/ai/prompts";

/** One non-streaming JSON call, with a single stricter retry on parse failure. */
async function jsonCall(
  prompt: string,
  maxTokens = 1400,
  feature: AiFeature = "other",
  /** stable text shared across calls, sent ahead of `prompt` so it can be cached */
  shared?: string[],
): Promise<Record<string, unknown>> {
  // Wrapped in failover: a dead key, a rate limit or a model that simply
  // cannot produce JSON all hand off to the standby provider.
  return callWithFailover(async (cfg, adapter) => {
    const ask = (text: string) =>
      adapter.complete({
        cfg,
        system: JSON_SYSTEM,
        shared,
        prompt: text,
        maxTokens,
        feature,
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
    console.error(
      `[ai] unparseable JSON reply (${raw.length} chars): ${raw.slice(0, 400)}`,
    );
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

/** "+09:00" for 540: a fixed-offset zone the date helpers accept. */
export function offsetZone(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(Math.round(offsetMinutes));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * The tasks a briefing for `dateLocal` covers, on the clock it is read on
 * (`tz`): what Today would show that day, overdue first. All-day tasks belong
 * to the calendar date they were set for at home, so they keep that date
 * wherever the user wakes up rather than sliding a day with the offset.
 */
export function briefingTasks(
  open: Task[],
  opts: { dateLocal: string; tz: string; homeTz: string; now?: Date },
): { overdue: Task[]; dueToday: Task[] } {
  const { dateLocal, tz, homeTz, now = new Date() } = opts;
  const onClock = (t: Task): Task =>
    t.allDay && t.dueAt && tz !== homeTz
      ? { ...t, dueAt: utcFromLocal(localDateKey(t.dueAt, homeTz), "00:00", tz) }
      : t;
  const startOfDay = instantOf(utcFromLocal(dateLocal, "00:00", tz));
  const startOfTomorrow = instantOf(utcFromLocal(addDaysToDateKey(dateLocal, 1), "00:00", tz));
  const startOfDayAfter = instantOf(utcFromLocal(addDaysToDateKey(dateLocal, 2), "00:00", tz));
  const isOverdue = (t: Task): boolean => t.dueAt !== null && instantOf(t.dueAt) < startOfDay;

  // Mirrors what Today actually shows: due by the end of the day, plus live
  // deadlines; project work stays on its own tab unless it lands within a day.
  const today = open
    .map(onClock)
    .filter((t) => t.status === "open" && !t.parentId && t.dueAt !== null)
    .filter((t) => instantOf(t.dueAt!) < startOfTomorrow || t.dueKind === "by")
    .filter((t) => !t.projectId || instantOf(t.dueAt!) < startOfDayAfter);
  const rank = (t: Task): number => (isOverdue(t) ? 4 : effectivePriority(t, tz, now));
  today.sort(
    (a, b) =>
      rank(b) - rank(a) || instantOf(a.dueAt!) - instantOf(b.dueAt!) || a.sort - b.sort,
  );
  return { overdue: today.filter(isOverdue), dueToday: today.filter((t) => !isOverdue(t)) };
}

/**
 * The events that belong to `dateLocal`. A day's window in another zone
 * overlaps the neighbouring home day, but an all-day event belongs to its own
 * calendar date (start inclusive, end exclusive), like an all-day task.
 */
export function eventsOnDate(events: CalendarEvent[], dateLocal: string): CalendarEvent[] {
  return events.filter((e) => {
    if (!e.allDay) return true;
    const start = e.start.slice(0, 10);
    const end = e.end.slice(0, 10) > start ? e.end.slice(0, 10) : addDaysToDateKey(start, 1);
    return start <= dateLocal && dateLocal < end;
  });
}

export async function generateBriefing(
  dateLocal: string,
  opts: {
    force?: boolean;
    /** minutes east of UTC where the user is waking up, while travelling */
    awayOffsetMinutes?: number | null;
  } = {}
): Promise<Briefing> {
  if (!opts.force) {
    const cached = briefingsRepo.get(dateLocal);
    if (cached) return cached;
  }

  const home = await buildAssistantContext();
  const homeTz = home.tz;
  // The briefing reads the clock it is sent on: the destination's while
  // travelling, and always the date it is filed under.
  const offset = opts.awayOffsetMinutes;
  const away = typeof offset === "number" && Number.isFinite(offset) && Math.abs(offset) <= 14 * 60;
  const tz = away ? offsetZone(offset) : homeTz;
  const now = new Date();

  const open = tasksRepo.list({});
  const { overdue, dueToday } = briefingTasks(open, { dateLocal, tz, homeTz, now });
  const today = [...overdue, ...dueToday];
  const stats = statsRepo.summary();

  // Off the home clock, everything dated is rebuilt for the briefing's day:
  // the home context describes a different one.
  const ctx: AssistantContext =
    !away && dateLocal === home.todayKey
      ? home
      : {
          ...home,
          tz,
          todayKey: dateLocal,
          weekday: format(new TZDate(new Date(`${dateLocal}T12:00:00Z`), "UTC"), "EEEE"),
          dateLabel: format(new TZDate(new Date(`${dateLocal}T12:00:00Z`), "UTC"), "EEEE, d MMMM yyyy"),
          timeLabel: localTimeKey(now, tz),
          calendarList: buildCalendarList(
            eventsOnDate(
              await safeEventsBetween(
                utcFromLocal(dateLocal, "00:00", tz),
                utcFromLocal(addDaysToDateKey(dateLocal, 1), "00:00", tz),
              ),
              dateLocal,
            ),
            tz,
          ),
          // Nothing is done yet on a day that has only just begun here.
          statsLine: `${today.length} on today's list · ${stats.totalOpen} open overall · ${overdue.length} overdue · ${stats.streakDays}-day streak`,
        };
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
      // Away, the forecast's day is wherever the last position fix was.
      weather: await safeWeatherLine(away ? "auto" : homeTz),
    }),
    900,
    "briefing",
  );

  const known = new Set(today.map((t) => t.id));
  for (const t of tasksRepo.list({ view: "anytime", excludeProjects: true })) known.add(t.id);
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

// ── Weekly review ──────────────────────────────────────────────────────────

/** Personal top-level tasks created in [fromIso, toIso), done or not. Counted
 *  in SQL: a capped task list drops the newest once the history grows. */
function countCreatedBetween(fromIso: string, toIso: string): number {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) c FROM tasks WHERE parent_id IS NULL AND space='personal' AND created_at >= ? AND created_at < ?",
    )
    .get(fromIso, toIso) as { c: number };
  return row.c;
}

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

  const createdCount = countCreatedBetween(
    isoFromLocal(from, "00:00", tz),
    isoFromLocal(addDaysToDateKey(to, 1), "00:00", tz),
  );

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
    1000,
    "review",
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
    4000,
    "breakdown",
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

export function parseLocalDue(raw: unknown, tz: string): { dueAt: string | null; allDay: boolean } {
  const value = asString(raw)?.trim() ?? "";
  if (!value || /^(null|none)$/i.test(value)) return { dueAt: null, allDay: false };
  // Read the shapes a model drifts into ("5:00 PM", "5pm", "EOD") the same
  // way triage's own deadlines are, so breakdown drafts and updates agree.
  const local = normalizeLocalDue(value);
  if (local) {
    const [date, time] = local.split(" ");
    return time
      ? { dueAt: utcFromLocal(date, time, tz), allDay: false }
      : { dueAt: utcFromLocal(date, "00:00", tz), allDay: true };
  }
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
    /** what the item was actually asking for — becomes the task's notes */
    summary: string;
    dueAtLocal: string | null;
    dueKind: "on" | "by";
    /** whether the item named the date, or the model worked one out */
    deadlineBasis: DeadlineBasis;
    /** the model's reason for an inferred date */
    deadlineWhy: string;
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
      summary: (asString(rec.summary ?? rec.notes) ?? "").trim().slice(0, 400),
      dueAtLocal: asString(rec.dueAtLocal ?? rec.dueAt) ?? null,
      dueKind: asString(rec.dueKind)?.toLowerCase() === "by" ? "by" : "on",
      deadlineBasis: readBasis(rec.deadlineBasis),
      deadlineWhy: (asString(rec.deadlineWhy) ?? "").trim().slice(0, 100),
      // A task always carries a real priority — "none" isn't an answer for
      // something that has to be done.
      priority: settlePriority(rec.priority ?? priorityNum),
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

/** The user's notes are kept whole; only the new stamp is capped. */
export function appendUpdateNote(existing: string, addition: string, todayKey: string): string {
  const stamp = `Update (${todayKey}): ${addition.trim()}`.slice(0, 300);
  return existing.trim() ? `${existing.trimEnd()}\n\n${stamp}` : stamp;
}

/** Titles as a model echoes them back: case, spacing, quotes and a trailing
 *  full stop are not what makes two tasks different. */
function titleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[“”"‘’'`]/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!,;:]+$/, "")
    .trim();
}

/** The open task an update verdict names, looked up across every list the
 *  triage prompt showed: personal first, then the joint list. */
export function findUpdateTarget(title: string, tasks: Task[]): Task | null {
  const wanted = title.trim().toLowerCase();
  if (!wanted) return null;
  const exact = tasks.find((t) => t.title.trim().toLowerCase() === wanted);
  if (exact) return exact;
  const key = titleKey(title);
  return key ? (tasks.find((t) => titleKey(t.title) === key) ?? null) : null;
}

/** Nothing but triage may have touched the item while the model thought it
 *  over: still new, with the suggestion it had when triage read it. */
function untouchedSince(before: InboxItem, now: InboxItem | null): now is InboxItem {
  return (
    now !== null &&
    now.status === "new" &&
    JSON.stringify(now.suggestion ?? null) === JSON.stringify(before.suggestion ?? null)
  );
}

/**
 * Who is who, seen from `role`. A blank name falls back by viewpoint: the
 * other person is always "your partner", never "You".
 */
export function viewpointNames(
  joint: { ownerName: string; partnerName: string },
  role: SessionRole,
): { personName: string; partnerName: string } {
  const own = (role === "owner" ? joint.ownerName : joint.partnerName).trim();
  const other = (role === "owner" ? joint.partnerName : joint.ownerName).trim();
  return { personName: own || "You", partnerName: other || "your partner" };
}

/**
 * Triage decides AND acts: clearly-irrelevant or already-tracked GMAIL items
 * are dismissed on the spot; items carrying NEW info about an open task update
 * that task directly. The verdict is stored first, so History always shows
 * why. Items the user captured themselves (sms/quick) are never auto-closed
 * without an action being taken — a dismiss verdict just becomes an "ignore"
 * suggestion they can act on.
 */
/**
 * The morning digest of the shared list for one person. Only what they should
 * hear about reaches the model — the other person's tasks never leave the
 * filter in jointDigest.ts.
 */
export async function generateJointDigest(role: SessionRole): Promise<string> {
  const settings = settingsRepo.getApp();
  const tz = settings.tz;
  const now = new Date();
  const todayKey = localDateKey(now, tz);

  const joint = tasksRepo.list({ space: "joint" });
  const { mine, ours } = splitForDigest(joint, role);
  // Their own asks of the other person, gone past due — theirs to know about,
  // and the reason the other person only ever hears one nudge.
  const waiting = waitingOn(joint, role, now, tz);
  if (mine.length === 0 && ours.length === 0 && waiting.length === 0) return "";

  const { personName, partnerName } = viewpointNames(settings.joint, role);

  const fallback = fallbackDigest({ mine, ours, partnerName, waiting: waiting.length, tz, now });
  if (!aiConfigured()) return fallback;

  try {
    const payload = await jsonCall(
      jointDigestPrompt({
        personName,
        partnerName,
        todayKey,
        weekday: format(new TZDate(now, tz), "EEEE"),
        tz,
        mine: digestLinesFor(mine, tz, now).join("\n"),
        ours: digestLinesFor(ours, tz, now).join("\n"),
        waiting: waitingLines(waiting, partnerName),
      }),
      400,
      "jointDigest",
    );
    const text = (asString(payload.digest) ?? "").trim();
    return text ? text.slice(0, 240) : fallback;
  } catch (err) {
    console.error("[digest] generation", err);
    return fallback;
  }
}

/**
 * The Sunday week-ahead for one person. Same privacy rule as the daily
 * digest: the other person's tasks never reach the model, only their count.
 */
export async function generateWeekAhead(
  role: SessionRole,
  events: CalendarEvent[],
  weekOf: string,
): Promise<string> {
  const settings = settingsRepo.getApp();
  const tz = settings.tz;

  const ctx = weekAheadContext({ tasks: tasksRepo.list({ space: "joint" }), events, role, tz });
  if (!worthSending(ctx)) return "";

  const { personName, partnerName } = viewpointNames(settings.joint, role);

  const fallback = fallbackWeekAhead(ctx, partnerName);
  if (!aiConfigured()) return fallback;

  try {
    const lines = contextLines(ctx);
    const payload = await jsonCall(
      weekAheadPrompt({
        personName,
        partnerName,
        weekOf,
        tz,
        mine: lines.mine,
        ours: lines.ours,
        events: lines.events,
        theirCount: ctx.theirCount,
      }),
      500,
      "weekAhead",
    );
    const text = (asString(payload.digest) ?? "").trim();
    return text ? text.slice(0, 300) : fallback;
  } catch (err) {
    console.error("[weekAhead] generation", err);
    return fallback;
  }
}

// One triage per item at a time: a second caller for the same item shares the
// first one's answer instead of paying for another model call. On globalThis
// so the scheduler and the routes see one map, and a dev reload keeps it.
const triageGlobal = globalThis as unknown as { __donexTriageInFlight?: Map<string, Promise<InboxItem>> };
const triageInFlight = (triageGlobal.__donexTriageInFlight ??= new Map<string, Promise<InboxItem>>());

export function triageInboxItem(id: string): Promise<InboxItem> {
  const running = triageInFlight.get(id);
  if (running) return running;
  const job = triageOnce(id).finally(() => triageInFlight.delete(id));
  triageInFlight.set(id, job);
  return job;
}

async function triageOnce(id: string): Promise<InboxItem> {
  const item = inboxRepo.get(id);
  if (!item) throw new Error("Inbox item not found");
  // Only untriaged items are worth a model call. A run that lags behind
  // another, or a request for an item the user already settled, gets the
  // item as it stands.
  if (item.status !== "new" || item.suggestion !== null) return item;

  const tz = settingsRepo.getApp().tz;
  const now = new Date();
  const todayKey = localDateKey(now, tz);
  const projects = projectsRepo.list();

  const parts = triagePrompt({
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
  });
  // The rules and the user's context are shared by every item in a run, so
  // they ride ahead of the item where the provider can serve them from cache.
  const payload = await jsonCall(parts.item, 900, "triage", [parts.instructions, parts.context]);

  // The call can take a minute. If the user acted on the item meanwhile, or
  // another run got to it first, that outcome stands. Everything from here on
  // is synchronous, so nothing can slip in between this check and the writes.
  const current = inboxRepo.get(id);
  if (!untouchedSince(item, current)) return current ?? item;

  const parsed = parseTriageDecision(payload, item.content);
  const suggestion: InboxSuggestion = { action: "ignore", reason: parsed.reason };

  if (parsed.decision === "task" && parsed.task) {
    // Every task leaves here with a deadline: the one the item gave, or one
    // worked out from what it asks — and if even that failed, a week.
    const deadline = settleDeadline({
      dueAtLocal: parsed.task.dueAtLocal,
      basis: parsed.task.deadlineBasis,
      why: parsed.task.deadlineWhy,
      dueKind: parsed.task.dueKind,
      todayKey,
    });
    const due = parseLocalDue(deadline.dueAtLocal, tz);
    const project = parsed.task.projectName
      ? projects.find((p) => p.name.toLowerCase() === parsed.task!.projectName!.toLowerCase())
      : undefined;
    suggestion.action = "task";
    suggestion.task = {
      title: parsed.task.title,
      notes: composeInboxNotes({
        summary: parsed.task.summary,
        content: item.content,
        fromLabel: item.fromLabel,
        source: item.source,
        receivedAt: item.receivedAt,
        suggestedDeadline: deadline.inferred ? deadline.why : null,
        tz,
      }),
      dueAt: due.dueAt,
      dueKind: due.dueAt ? deadline.dueKind : "on",
      allDay: due.allDay,
      priority: parsed.task.priority,
      projectId: project?.id ?? null,
      tags: parsed.task.tags,
    };
    if (deadline.inferred) {
      suggestion.dueSuggested = true;
      suggestion.dueWhy = deadline.why;
    }
  } else if (parsed.decision === "note" && parsed.note) {
    suggestion.action = "note";
    suggestion.note = { ...parsed.note, content: parsed.note.content || item.content };
  } else if (parsed.decision === "update" && parsed.update) {
    // The same lists the prompt showed the model: personal and joint.
    const target = findUpdateTarget(parsed.update.taskTitle, [
      ...tasksRepo.list({ view: "all" }),
      ...tasksRepo.list({ space: "joint" }),
    ]);

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

      if (target.space === "joint") {
        // The partner reads the shared list too, so news from the owner's own
        // mail or texts never lands there unseen: nothing is applied and no
        // summary is copied. The card names the task and the change instead.
        suggestion.action = "task";
        suggestion.reason =
          `News for the shared task “${target.title.slice(0, 40)}”${changes.length ? ` — ${changes.join(", ")}` : ""}`.slice(0, 90);
      } else {
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
    } else {
      // Couldn't match the task the model named. Keep the item in front of the
      // user as a task to add: an "ignore" verdict would let the sweep dismiss
      // news about something they are tracking.
      const named = parsed.update.taskTitle || item.content;
      // Settled like any other triaged task: the date the item gave, or a
      // sensible one, and a real priority.
      const deadline = settleDeadline({
        dueAtLocal: parsed.update.dueAtLocal,
        basis: parsed.update.dueAtLocal ? "stated" : "inferred",
        why: "",
        dueKind: "on",
        todayKey,
      });
      const due = parseLocalDue(deadline.dueAtLocal, tz);
      suggestion.action = "task";
      suggestion.reason = parsed.update.taskTitle
        ? `Mentions “${parsed.update.taskTitle.slice(0, 50)}” but no open task matches`
        : "News about a task, but no open task matches";
      suggestion.task = {
        title: named.slice(0, 80),
        notes: composeInboxNotes({
          summary: parsed.update.note,
          content: item.content,
          fromLabel: item.fromLabel,
          source: item.source,
          receivedAt: item.receivedAt,
          suggestedDeadline: deadline.inferred ? deadline.why : null,
          tz,
        }),
        dueAt: due.dueAt,
        dueKind: due.dueAt ? deadline.dueKind : "on",
        allDay: due.allDay,
        priority: settlePriority(parsed.update.priority),
        projectId: null,
        tags: [],
      };
      if (deadline.inferred) {
        suggestion.dueSuggested = true;
        suggestion.dueWhy = deadline.why;
      }
    }
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
