/**
 * Background loop (60s tick) started from src/instrumentation.ts.
 * Every step is independently guarded — the loop must never die.
 */
import "server-only";
import { setInterval as setNodeInterval, setTimeout as setNodeTimeout } from "node:timers";
import {
  completionsRepo,
  googleRepo,
  inboxRepo,
  projectsRepo,
  settingsRepo,
  tasksRepo,
} from "@/lib/db/repos";
import {
  aiConfigured,
  generateBriefing,
  generateWeeklyReview,
  refreshFallbackModel,
  sweepAutoDismissable,
  triageInboxItem,
} from "@/lib/ai";
import { scanGmail } from "@/lib/google/gmail";
import { hasPushSubscriptions, sendPushToAll } from "@/lib/push";
import { MAX_INBOX_ALERTS_PER_DAY, readAlertBudget } from "@/lib/alertbudget";
import {
  addDaysToDateKey,
  isoWeekKey,
  isQuietTime,
  localDateKey,
  localTimeKey,
  mapLimit,
  nowIso,
} from "@/lib/utils";
import type { AppSettings, Briefing, WeeklyReview } from "@/lib/types";

const TICK_MS = 60_000;
const FIRST_TICK_DELAY_MS = 5_000;
const GMAIL_SCAN_INTERVAL_MS = 60 * 60 * 1000;

const KV_LAST_BRIEFING_DAY = "sched.lastBriefingDay";
const KV_LAST_REVIEW_WEEK = "sched.lastReviewWeek";
const KV_LAST_GMAIL_SCAN = "sched.lastGmailScan";
const KV_LAST_TRIAGE_SLOT = "sched.lastTriageSlot";
const KV_INBOX_ALERTS = "sched.inboxAlerts";

/** Fixed inbox-triage times (local, user's tz): morning, midday, evening. */
const TRIAGE_TIMES = ["06:00", "14:00", "20:00"];

const globalForScheduler = globalThis as unknown as { __donexSchedulerStarted?: boolean };
let ticking = false;

export function startScheduler(): void {
  if (globalForScheduler.__donexSchedulerStarted) return;
  globalForScheduler.__donexSchedulerStarted = true;

  setNodeTimeout(() => void tick(), FIRST_TICK_DELAY_MS).unref();
  setNodeInterval(() => void tick(), TICK_MS).unref();
  console.log("[scheduler] started");
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const settings = settingsRepo.getApp();
    const now = new Date();
    await runReminders(settings);
    await runMorningBriefing(settings, now);
    await runWeeklyReview(settings, now);
    await runGmailScan(settings);
    await runScheduledTriage(settings, now);
    await runBackupModelRefresh(settings, now);
  } catch (err) {
    console.error("[scheduler] tick", err);
  } finally {
    ticking = false;
  }
}

// ── 0. Keep the backup model current ───────────────────────────────────────

/** Re-checks the standby provider once a day, so a newer flagship is adopted
 *  without anyone having to notice it shipped. */
async function runBackupModelRefresh(settings: AppSettings, now: Date): Promise<void> {
  try {
    if (!settings.ai.fallbackProvider) return;
    const todayKey = localDateKey(now, settings.tz);
    if (settingsRepo.getKV("ai.fallbackModelCheckedOn") === todayKey) return;
    settingsRepo.setKV("ai.fallbackModelCheckedOn", todayKey);
    await refreshFallbackModel();
  } catch (err) {
    console.error("[scheduler] backup model refresh", err);
  }
}

// ── 1. Task reminders ──────────────────────────────────────────────────────

/**
 * Send an "open your inbox" alert unless today's allowance is spent. Triage
 * still runs its full cadence — this only caps the interruptions. A suppressed
 * run is silent by design: the items are in the inbox and the tab badge counts
 * them. Reminders, briefings and the weekly review are unaffected.
 */
async function notifyInbox(
  tz: string,
  payload: { title: string; body: string; url: string },
): Promise<boolean> {
  if (!hasPushSubscriptions()) return false;
  const dayKey = localDateKey(new Date(), tz);
  const budget = readAlertBudget(settingsRepo.getKV(KV_INBOX_ALERTS), dayKey);
  if (!budget.allowed || !budget.next) {
    console.log(
      `[scheduler] inbox alert held back — ${MAX_INBOX_ALERTS_PER_DAY}/day already sent`,
    );
    return false;
  }
  await sendPushToAll(payload, ["owner"]);
  settingsRepo.setKV(KV_INBOX_ALERTS, budget.next);
  return true;
}

async function runReminders(settings: AppSettings): Promise<void> {
  try {
    if (!settings.notifications.remindersEnabled) return;
    if (!hasPushSubscriptions()) return;

    const due = tasksRepo.dueForReminder(nowIso());
    if (due.length === 0) return;

    const projectNames = new Map(projectsRepo.list(true).map((p) => [p.id, p.name]));
    for (const task of due) {
      const parts: string[] = [];
      if (task.dueAt) parts.push(`Due at ${formatLocalTime(task.dueAt, settings.tz)}`);
      const project = task.projectId ? projectNames.get(task.projectId) : undefined;
      if (project) parts.push(project);
      const joint = task.space === "joint";
      await sendPushToAll(
        {
          title: `⏰ ${task.title}`,
          body: (joint ? [...parts, "Joint list"] : parts).join(" · ") || "Due now",
          url: joint ? "/joint" : "/today",
          tag: `task-${task.id}`,
        },
        joint ? undefined : ["owner"],
      );
      tasksRepo.markNotified(task.id);
    }
  } catch (err) {
    console.error("[scheduler] reminders", err);
  }
}

// ── 2. Morning briefing ────────────────────────────────────────────────────

async function runMorningBriefing(settings: AppSettings, now: Date): Promise<void> {
  try {
    if (!settings.notifications.briefingEnabled) return;

    const tz = settings.tz;
    if (localTimeKey(now, tz) !== normalizeTime(settings.notifications.briefingTime)) return;

    const dateLocal = localDateKey(now, tz);
    if (settingsRepo.getKV(KV_LAST_BRIEFING_DAY) === dateLocal) return;
    settingsRepo.setKV(KV_LAST_BRIEFING_DAY, dateLocal); // claim the slot first

    let briefing: Briefing | null = null;
    if (aiConfigured()) {
      try {
        briefing = await generateBriefing(dateLocal);
      } catch (err) {
        console.error("[scheduler] briefing generation", err);
      }
    }

    const openToday = tasksRepo.list({ view: "today" }).length;
    await sendPushToAll(
      {
        title: briefing?.greeting || "Good morning ☀️",
        body: briefing?.narrative || `${openToday} tasks on deck today.`,
        url: "/today",
      },
      ["owner"],
    );
  } catch (err) {
    console.error("[scheduler] briefing", err);
  }
}

// ── 3. Weekly review ───────────────────────────────────────────────────────

async function runWeeklyReview(settings: AppSettings, now: Date): Promise<void> {
  try {
    if (!settings.notifications.weeklyReviewEnabled) return;

    const tz = settings.tz;
    const dateLocal = localDateKey(now, tz);
    if (localWeekday(dateLocal) !== settings.notifications.weeklyDay) return;
    if (localTimeKey(now, tz) !== normalizeTime(settings.notifications.weeklyTime)) return;

    const weekKey = isoWeekKey(now, tz);
    if (settingsRepo.getKV(KV_LAST_REVIEW_WEEK) === weekKey) return;
    settingsRepo.setKV(KV_LAST_REVIEW_WEEK, weekKey);

    let review: WeeklyReview | null = null;
    if (aiConfigured()) {
      try {
        review = await generateWeeklyReview(weekKey);
      } catch (err) {
        console.error("[scheduler] review generation", err);
      }
    }

    const completed =
      review?.completedCount ??
      completionsRepo.countRange(addDaysToDateKey(dateLocal, -6), dateLocal);
    await sendPushToAll(
      {
        title: "Your week in review",
        body: firstSentence(review?.narrative) || `${completed} task(s) completed this week.`,
        url: "/review",
      },
      ["owner"],
    );
  } catch (err) {
    console.error("[scheduler] weekly review", err);
  }
}

// ── 4. Gmail scan ──────────────────────────────────────────────────────────

/** Bedtime window: DoneX leaves Gmail completely alone during these hours. */
function inQuietHours(settings: AppSettings): boolean {
  const n = settings.notifications;
  if (!n.quietHoursEnabled) return false;
  return isQuietTime(localTimeKey(new Date(), settings.tz), n.quietStart, n.quietEnd);
}

async function runGmailScan(settings: AppSettings): Promise<void> {
  try {
    if (!settings.google.gmailScanEnabled) return;
    if (!googleRepo.get()) return;
    if (inQuietHours(settings)) return;

    const last = settingsRepo.getKV(KV_LAST_GMAIL_SCAN);
    const lastMs = last ? Date.parse(last) : NaN;
    if (Number.isFinite(lastMs) && Date.now() - lastMs < GMAIL_SCAN_INTERVAL_MS) return;
    settingsRepo.setKV(KV_LAST_GMAIL_SCAN, nowIso());

    // Only what SURVIVES auto-triage into the visible inbox is worth a ping —
    // mail that arrived and went straight to History should stay silent.
    const before = inboxRepo.newCount();
    const created = await scanGmail();
    if (created > 0) {
      const survived = Math.max(0, inboxRepo.newCount() - before);
      if (survived > 0) {
        await notifyInbox(settings.tz, {
          title: "Inbox",
          body: `${survived} new item${survived === 1 ? "" : "s"} to triage`,
          url: "/inbox",
        });
      }
    }
  } catch (err) {
    console.error("[scheduler] gmail scan", err);
  }
}

// ── 5. Scheduled inbox triage (06:00 / 14:00 / 20:00 local) ────────────────

async function runScheduledTriage(settings: AppSettings, now: Date): Promise<void> {
  try {
    if (!aiConfigured()) return;

    const tz = settings.tz;
    const slot = TRIAGE_TIMES.find((t) => t === localTimeKey(now, tz));
    if (!slot) return;

    const slotKey = `${localDateKey(now, tz)}@${slot}`;
    if (settingsRepo.getKV(KV_LAST_TRIAGE_SLOT) === slotKey) return;
    settingsRepo.setKV(KV_LAST_TRIAGE_SLOT, slotKey); // claim before the slow work

    // Snapshot what was already visible: only NEW survivors justify a ping —
    // items the user has been ignoring since a previous slot don't.
    const seenBefore = new Set(inboxRepo.list({ status: "new" }).map((i) => i.id));

    // Pull fresh mail first (untriaged) so this pass owns every verdict and
    // can report exactly what happened. Never during bedtime hours.
    let created = 0;
    if (settings.google.gmailScanEnabled && googleRepo.get() && !inQuietHours(settings)) {
      try {
        created = await scanGmail({ triage: false });
      } catch (err) {
        console.error("[scheduler] triage pre-scan", err);
      }
    }

    let dismissed = sweepAutoDismissable();

    const pending = inboxRepo
      .list({ status: "new" })
      .filter((item) => item.suggestion === null)
      .slice(0, 30);
    if (created === 0 && pending.length === 0 && dismissed === 0) return; // nothing to do

    await mapLimit(pending, 2, (item) => triageInboxItem(item.id));

    let updated = 0;
    for (const before of pending) {
      const after = inboxRepo.get(before.id);
      if (!after || after.status === "new") continue;
      if (after.status === "resolved") updated += 1;
      else dismissed += 1;
    }

    const freshKept = inboxRepo
      .list({ status: "new" })
      .filter((i) => !seenBefore.has(i.id)).length;

    // Silence unless this run surfaced something genuinely new or acted on a
    // task — wholly auto-dismissed batches and stale leftovers don't ping.
    if (freshKept > 0 || updated > 0) {
      const parts = [
        freshKept > 0 ? `${freshKept} new for you` : "",
        updated > 0 ? `${updated} task${updated === 1 ? "" : "s"} updated` : "",
        dismissed > 0 ? `${dismissed} auto-dismissed` : "",
      ].filter(Boolean);
      await notifyInbox(tz, { title: "Inbox triage", body: parts.join(" · "), url: "/inbox" });
    }
  } catch (err) {
    console.error("[scheduler] triage", err);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/** "7:00" → "07:00" so comparisons against localTimeKey() are exact. */
function normalizeTime(value: string): string {
  const [hh = "", mm = ""] = value.trim().split(":");
  return `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`;
}

function formatLocalTime(iso: string, tz: string): string {
  const [hh, mm] = localTimeKey(iso, tz).split(":").map(Number);
  const suffix = hh >= 12 ? "PM" : "AM";
  const hour12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${hour12}:${String(mm).padStart(2, "0")} ${suffix}`;
}

/** 0=Sun … 6=Sat for a local "YYYY-MM-DD" key */
function localWeekday(dateLocal: string): number {
  const [y, m, d] = dateLocal.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function firstSentence(text: string | undefined): string {
  if (!text) return "";
  const trimmed = text.trim();
  const match = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/);
  return (match ? match[0] : trimmed).slice(0, 200).trim();
}
