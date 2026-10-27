/**
 * Background loop (60s tick) started from src/instrumentation.ts.
 * Every step is independently guarded — the loop must never die.
 */
import "server-only";
import { setInterval as setNodeInterval, setTimeout as setNodeTimeout } from "node:timers";
import {
  briefingsRepo,
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
  generateJointDigest,
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
  isQuietTime,
  localDateKey,
  localTimeKey,
  mapLimit,
  nowIso,
} from "@/lib/utils";
import { runBackup } from "@/lib/backup";
import { ownerTrips } from "@/lib/jointFeeds";
import { activeTrip, wallClockAt, type Trip } from "@/lib/trips";
import {
  CATCH_UP_MINUTES,
  openSlot,
  shouldSendDigest,
  type DigestSchedule,
} from "@/lib/jointDigest";
import {
  normalizeWeekTime,
  shouldSendWeekAhead,
  type WeekAheadSchedule,
} from "@/lib/weekAhead";
import { nudgeText, nudgesFor } from "@/lib/nudges";
import { reviewedWeek, weekKeyOfDay } from "@/lib/reviewWeek";
import { buildWeekAhead, kvLastWeekAheadWeek } from "@/lib/weekAheadStore";
import type { AppSettings, Briefing, SessionRole, Task, WeeklyReview } from "@/lib/types";

const TICK_MS = 60_000;
const FIRST_TICK_DELAY_MS = 5_000;
const GMAIL_SCAN_INTERVAL_MS = 60 * 60 * 1000;

const KV_LAST_BRIEFING_DAY = "sched.lastBriefingDay";
/** Before reviews covered the week just gone, this held the week the send fell in. */
const KV_LAST_REVIEW_WEEK = "sched.lastReviewWeek";
/** The week the last review was about. */
const KV_LAST_REVIEWED_WEEK = "sched.lastReviewedWeek";
const KV_LAST_GMAIL_SCAN = "sched.lastGmailScan";
const KV_LAST_TRIAGE_SLOT = "sched.lastTriageSlot";
const KV_INBOX_ALERTS = "sched.inboxAlerts";
const KV_LAST_BACKUP_WEEK = "sched.lastBackupWeek";
/** Per person, so a nudge is a once-a-day check rather than every tick. */
const kvLastNudgeDay = (role: SessionRole) => `sched.lastNudge.${role}`;
/** A nudge that reached no device is tried again this often, this many times a day. */
const NUDGE_RETRY_MS = 30 * 60 * 1000;
const NUDGE_MAX_TRIES = 3;
/** Sunday evening, after the week-ahead hour and clear of the digests. */
const BACKUP_DAY = 0;
const BACKUP_TIME = "21:00";
/** Per person, so the two digests can run hours apart. */
const kvLastDigestDay = (role: SessionRole) => `sched.lastJointDigest.${role}`;

/** Fixed inbox-triage times (local, user's tz): morning, midday, evening. */
const TRIAGE_TIMES = ["06:00", "14:00", "20:00"];

/** A reminder later than this isn't one any more: it is let go without a buzz. */
const REMINDER_STALE_MS = CATCH_UP_MINUTES * 60 * 1000;
/** A briefing someone opened this long before the morning send is made again for it. */
const BRIEFING_FRESH_MS = 60 * 60 * 1000;

/**
 * Where the owner is: on a trip, at home (null), or "unknown" — the calendar
 * hasn't been read once since this process started.
 */
type Whereabouts = Trip | null | "unknown";

/** Where you are right now, re-read hourly — shifts move week to week, so
 *  this never assumes yesterday's answer still holds. */
let awayCache: { at: number; ttl: number; trip: Whereabouts } = { at: 0, ttl: 0, trip: null };
const AWAY_TTL_MS = 60 * 60 * 1000;
/** After a failed calendar read: try again soon, and don't decide anything on it. */
const AWAY_RETRY_MS = 5 * 60 * 1000;
/** With no good read since start, the owner's jobs wait this long before falling back to home time. */
const TRIP_UNKNOWN_MAX_MS = 30 * 60 * 1000;
let tripEverRead = false;
let tripFailingSince: number | null = null;

async function currentTrip(settings: AppSettings, now: Date): Promise<Whereabouts> {
  if (now.getTime() - awayCache.at < awayCache.ttl) return awayCache.trip;
  // A calendar that couldn't be read says nothing about where you are. Keep
  // the last answer (while that trip is still on) rather than calling you
  // home, which would send the morning jobs on home time and claim the day.
  // With no answer yet, say so: the owner's jobs wait, and their catch-up
  // window sends them once a read works.
  const failed = (): Whereabouts => {
    if (tripEverRead) {
      const last = awayCache.trip;
      return activeTrip(last && last !== "unknown" ? [last] : [], now);
    }
    tripFailingSince ??= now.getTime();
    return now.getTime() - tripFailingSince < TRIP_UNKNOWN_MAX_MS ? "unknown" : null;
  };
  try {
    // The same reading of the calendar the Today card uses.
    const { trips, warning } = await ownerTrips(settings, now);
    if (warning) {
      console.error("[scheduler] trip lookup", warning);
      awayCache = { at: now.getTime(), ttl: AWAY_RETRY_MS, trip: failed() };
    } else {
      tripEverRead = true;
      tripFailingSince = null;
      awayCache = { at: now.getTime(), ttl: AWAY_TTL_MS, trip: activeTrip(trips, now) };
    }
  } catch (err) {
    console.error("[scheduler] trip lookup", err);
    awayCache = { at: now.getTime(), ttl: AWAY_RETRY_MS, trip: failed() };
  }
  return awayCache.trip;
}

/**
 * The clock a morning alert should follow: the destination's while you are
 * travelling, home otherwise. Keeps a 7am briefing at 7am where you woke up
 * rather than firing at 4am local.
 */
function clockFor(settings: AppSettings, now: Date, trip: Trip | null) {
  if (trip?.timeZone) {
    // A named zone follows its own DST, which a fixed offset can't.
    const dateKey = localDateKey(now, trip.timeZone);
    return {
      time: localTimeKey(now, trip.timeZone),
      dateKey,
      weekday: localWeekday(dateKey),
      away: true,
    };
  }
  if (trip && trip.offsetMinutes !== null) {
    const wall = wallClockAt(now, trip.offsetMinutes);
    return { time: wall.time, dateKey: wall.dateKey, weekday: wall.weekday, away: true };
  }
  const dateKey = localDateKey(now, settings.tz);
  return {
    time: localTimeKey(now, settings.tz),
    dateKey,
    weekday: localWeekday(dateKey),
    away: false,
  };
}

type Clock = ReturnType<typeof clockFor>;

/** The owner's clock, or null while where they are is still unknown. */
function ownerClock(settings: AppSettings, now: Date, trip: Whereabouts): Clock | null {
  return trip === "unknown" ? null : clockFor(settings, now, trip);
}

/**
 * The slot open on this clock, if any: the date and weekday it belongs to
 * (the evening before, for a late slot still open past midnight) — the ones
 * to decide and claim on — and how many minutes ago it opened.
 */
function openSlotOn(
  clock: Clock,
  slot: string,
): { dateKey: string; weekday: number; minutesIn: number } | null {
  const open = openSlot(clock.time, slot);
  if (!open) return null;
  const dateKey = open.dayOffset === 0 ? clock.dateKey : addDaysToDateKey(clock.dateKey, -1);
  return { dateKey, weekday: localWeekday(dateKey), minutesIn: open.minutesIn };
}

const globalForScheduler = globalThis as unknown as { __donexSchedulerStarted?: boolean };
let ticking = false;
let inboxBusy = false;

export function startScheduler(): void {
  if (globalForScheduler.__donexSchedulerStarted) return;
  globalForScheduler.__donexSchedulerStarted = true;

  setNodeTimeout(() => void tick(), FIRST_TICK_DELAY_MS).unref();
  setNodeInterval(() => void tick(), TICK_MS).unref();
  console.log("[scheduler] started");
}

/**
 * One pass of the loop (exported for tests). A tick that arrives while the
 * last one is still running is dropped, so every timed job is due-based:
 * it goes out at its minute or on the first tick inside its catch-up window,
 * and the per-day or per-week key it claims — stored in the database, so it
 * survives a restart — is what stops a second send.
 *
 * Inbox work (a Gmail scan, an AI triage batch) can run for minutes, so it
 * has a lane of its own and never holds up a reminder or a scheduled send.
 */
export async function tick(): Promise<void> {
  await Promise.all([runTimedJobs(), runInboxJobs()]);
}

async function runTimedJobs(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const settings = settingsRepo.getApp();
    const now = new Date();
    await runReminders(settings);
    const trip = await currentTrip(settings, now);
    await runMorningBriefing(settings, now, trip);
    await runWeeklyReview(settings, now);
    await runJointDigests(settings, now, trip);
    await runWeekAhead(settings, now, trip);
    await runNudges(settings, now, trip);
    await runWeeklyBackup(settings, now);
    await runBackupModelRefresh(settings, now);
  } catch (err) {
    console.error("[scheduler] tick", err);
  } finally {
    ticking = false;
  }
}

async function runInboxJobs(): Promise<void> {
  if (inboxBusy) return;
  inboxBusy = true;
  try {
    const settings = settingsRepo.getApp();
    await runGmailScan(settings);
    await runScheduledTriage(settings, new Date());
  } catch (err) {
    console.error("[scheduler] inbox", err);
  } finally {
    inboxBusy = false;
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

    const at = nowIso();
    // Anything long past is let go without a buzz — a backlog built up while
    // push was off, or brought back by a restore — a page at a time, oldest
    // first, so it never queues ahead of what is due now.
    const cutoff = Date.now() - REMINDER_STALE_MS;
    const stale = (t: Task) => Date.parse(t.dueAt ?? "") < cutoff;
    let due = tasksRepo.dueForReminder(at);
    for (let page = 0; page < 50 && due.some(stale); page++) {
      for (const t of due) if (stale(t)) tasksRepo.markNotified(t.id);
      due = tasksRepo.dueForReminder(at);
    }
    due = due.filter((t) => !stale(t));
    if (due.length === 0) return;

    const projectNames = new Map(projectsRepo.list(true).map((p) => [p.id, p.name]));
    for (const { id, dueAt } of due) {
      // Re-read and claimed right before its own send, never across an await:
      // a task rescheduled, completed or rolled to its next occurrence while
      // an earlier push was in flight is left alone, and anything not reached
      // yet (a restart, an error) is still unclaimed for the next tick.
      const task = tasksRepo.get(id);
      if (!task || task.status !== "open" || !sameInstant(task.dueAt, dueAt)) continue;
      tasksRepo.markNotified(id);

      const joint = task.space === "joint";
      const parts: string[] = [];
      if (task.dueAt) parts.push(`Due at ${formatLocalTime(task.dueAt, settings.tz)}`);
      // Projects are the owner's own; a joint reminder also reaches the partner.
      const project = !joint && task.projectId ? projectNames.get(task.projectId) : undefined;
      if (project) parts.push(project);
      await sendPushToAll(
        {
          title: `⏰ ${task.title}`,
          body: (joint ? [...parts, "Joint list"] : parts).join(" · ") || "Due now",
          url: joint ? "/joint" : "/today",
          tag: `task-${task.id}`,
        },
        // A joint task reaches the partner only while partner access is on.
        joint && settings.joint.partnerPinHash ? undefined : ["owner"],
      );
    }
  } catch (err) {
    console.error("[scheduler] reminders", err);
  }
}

// ── 2. Morning briefing ────────────────────────────────────────────────────

async function runMorningBriefing(
  settings: AppSettings,
  now: Date,
  trip: Whereabouts,
): Promise<void> {
  try {
    if (!settings.notifications.briefingEnabled) return;
    // Where you are decides the hour; until that is known, wait.
    if (trip === "unknown") return;

    const clock = clockFor(settings, now, trip);
    const slot = openSlotOn(clock, settings.notifications.briefingTime);
    if (!slot) return;

    // The day key follows the same clock, so a trip can't send two briefings
    // in one local day or skip one crossing a date line.
    const dateLocal = slot.dateKey;
    if (settingsRepo.getKV(KV_LAST_BRIEFING_DAY) === dateLocal) return;
    settingsRepo.setKV(KV_LAST_BRIEFING_DAY, dateLocal); // claim the slot first

    let briefing: Briefing | null = null;
    if (aiConfigured()) {
      try {
        // One made more than an hour before the slot (Today opened in the
        // small hours) is made again for the morning; one made since is what
        // the user has just read, however late this tick is.
        const cached = briefingsRepo.get(dateLocal);
        const slotAt = now.getTime() - slot.minutesIn * 60_000;
        const force = !!cached && Date.parse(cached.generatedAt) < slotAt - BRIEFING_FRESH_MS;
        briefing = await generateBriefing(dateLocal, {
          force,
          awayOffsetMinutes: clock.away ? (trip?.offsetMinutes ?? null) : null,
        });
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

// ── 2b. The shared list's morning digest, one per person ───────────────────

/**
 * Each person gets their own send time and hears only about their own tasks
 * and the unclaimed ones — the other person's jobs are theirs to be reminded
 * of. Sundays are skipped for both.
 */
async function runJointDigests(
  settings: AppSettings,
  now: Date,
  trip: Whereabouts,
): Promise<void> {
  const joint = settings.joint;
  // Yours follows you; hers stays on home time, since she hasn't gone anywhere.
  const mine = ownerClock(settings, now, trip);
  const home = clockFor(settings, now, null);

  const people: { role: SessionRole; schedule: DigestSchedule }[] = [
    {
      role: "owner",
      schedule: { enabled: joint.ownerDigestEnabled, time: joint.ownerDigestTime },
    },
    // Nobody to send to until the shared list has actually been turned on.
    ...(joint.partnerPinHash
      ? [
          {
            role: "partner" as SessionRole,
            schedule: {
              enabled: joint.partnerDigestEnabled,
              time: joint.partnerDigestTime,
            },
          },
        ]
      : []),
  ];

  for (const { role, schedule } of people) {
    try {
      const clock = role === "owner" ? mine : home;
      if (!clock) continue; // where you are is still unknown
      const slot = openSlotOn(clock, schedule.time);
      if (!slot) continue;
      const key = kvLastDigestDay(role);
      if (
        !shouldSendDigest({
          schedule,
          nowTime: clock.time,
          weekday: slot.weekday,
          today: slot.dateKey,
          lastSent: settingsRepo.getKV(key),
        })
      ) {
        continue;
      }
      settingsRepo.setKV(key, slot.dateKey); // claim the slot before the slow part

      const digest = await generateJointDigest(role);
      // An empty digest means an empty list — no reason to buzz anyone.
      if (!digest) continue;

      await sendPushToAll(
        { title: "Ours — this morning", body: digest, url: "/joint", tag: `joint-digest-${slot.dateKey}` },
        [role],
      );
    } catch (err) {
      console.error("[scheduler] joint digest", role, err);
    }
  }
}

// ── 2bb. Sunday evening, the week to come ──────────────────────────────────

/**
 * One look at the week ahead, Sunday evening, per person and at their own
 * hour. Same privacy line as the morning digest: your tasks and the
 * unclaimed ones, plus both calendars — which you already share — and a bare
 * count of what the other one is carrying.
 */
async function runWeekAhead(settings: AppSettings, now: Date, trip: Whereabouts): Promise<void> {
  const joint = settings.joint;
  // Yours follows you; hers stays on home time, since she hasn't gone anywhere.
  const mine = ownerClock(settings, now, trip);
  const home = clockFor(settings, now, null);

  const people: { role: SessionRole; schedule: WeekAheadSchedule }[] = [
    {
      role: "owner",
      schedule: { enabled: joint.ownerWeekAheadEnabled, time: joint.ownerWeekAheadTime },
    },
    // Nobody to send to until the shared list has actually been turned on.
    ...(joint.partnerPinHash
      ? [
          {
            role: "partner" as SessionRole,
            schedule: {
              enabled: joint.partnerWeekAheadEnabled,
              time: joint.partnerWeekAheadTime,
            },
          },
        ]
      : []),
  ];

  for (const { role, schedule } of people) {
    try {
      const clock = role === "owner" ? mine : home;
      if (!clock) continue; // where you are is still unknown
      const slot = openSlotOn(clock, normalizeWeekTime(schedule.time));
      if (!slot) continue;
      // The week of the clock that decides the send: Sunday evening on a trip
      // can already be Monday at home, which is next week's key.
      const weekKey = weekKeyOfDay(slot.dateKey);
      const key = kvLastWeekAheadWeek(role);
      if (
        !shouldSendWeekAhead({
          schedule,
          nowTime: clock.time,
          weekday: slot.weekday,
          weekKey,
          lastSent: settingsRepo.getKV(key),
        })
      ) {
        continue;
      }
      settingsRepo.setKV(key, weekKey); // claim the slot before the slow part

      const { text } = await buildWeekAhead(role, slot.dateKey);
      // A quiet week for this person is not worth a Sunday evening buzz.
      if (!text) continue;

      await sendPushToAll(
        { title: "The week ahead", body: text, url: "/joint", tag: `week-ahead-${weekKey}` },
        [role],
      );
    } catch (err) {
      console.error("[scheduler] week ahead", role, err);
    }
  }
}

// ── 2d. A word about work that has gone past due ───────────────────────────

/**
 * Once a day, whoever was asked to do something that is now late hears about
 * it — once per deadline, all of it in a single notification, and never the
 * person who did the asking. They see it as "still waiting on" in their own
 * morning digest instead, which is what lets this stay a single word rather
 * than a daily one.
 */
async function runNudges(settings: AppSettings, now: Date, trip: Whereabouts): Promise<void> {
  try {
    const joint = settings.joint;
    if (!joint.nudgeEnabled || !joint.partnerPinHash) return;

    // Yours follows you (and waits while that is unknown); hers stays on home
    // time, since she hasn't gone anywhere.
    const mine = ownerClock(settings, now, trip);
    const slots = {
      owner: mine ? openSlotOn(mine, joint.nudgeTime) : null,
      partner: openSlotOn(clockFor(settings, now, null), joint.nudgeTime),
    };
    if (!slots.owner && !slots.partner) return;

    const tasks = tasksRepo.list({ space: "joint" });
    const state = tasksRepo.nudgeState();
    const names = {
      owner: joint.ownerName || "Your partner",
      partner: joint.partnerName || "Your partner",
    };

    for (const role of ["owner", "partner"] as SessionRole[]) {
      const slot = slots[role];
      if (!slot) continue;

      const key = kvLastNudgeDay(role);
      const last = settingsRepo.getKV(key);
      if (last === slot.dateKey) continue;
      // A send today that reached nobody: try again now and then, not every tick.
      const tried = failedNudge(last, slot.dateKey);
      if (tried && (tried.count >= NUDGE_MAX_TRIES || now.getTime() - tried.at < NUDGE_RETRY_MS)) {
        continue;
      }
      settingsRepo.setKV(key, slot.dateKey); // claim the slot first

      const items = nudgesFor({
        tasks,
        role,
        now,
        // All-day deadlines end at midnight where they were set: home.
        tz: settings.tz,
        nudgedDueAt: (id) => state.get(id) ?? null,
      });
      if (items.length === 0) continue;

      const asker = role === "owner" ? names.partner : names.owner;
      const { title, body } = nudgeText(items, asker);
      const sent = await sendPushToAll(
        { title, body, url: "/joint", tag: `nudge-${slot.dateKey}` },
        [role],
      );
      if (sent === 0) {
        // Nothing reached them (no device, or every delivery failed): mark
        // nothing, and note the try so a later tick in the window — at most a
        // few times — or tomorrow's run tries again.
        const count = (tried?.count ?? 0) + 1;
        settingsRepo.setKV(key, `${slot.dateKey}#${count}@${now.getTime()}`);
        continue;
      }

      // Only after it has actually gone out, so a failed send tries again.
      for (const item of items) tasksRepo.markNudged(item.id, item.dueAt);
    }
  } catch (err) {
    console.error("[scheduler] nudges", err);
  }
}

// ── 2c. Weekly snapshot ────────────────────────────────────────────────────

/**
 * One snapshot a week, kept on the volume — plus a nudge to save a copy
 * somewhere that isn't this box, which is the only part a volume failure
 * can't take with it.
 */
async function runWeeklyBackup(settings: AppSettings, now: Date): Promise<void> {
  try {
    const slot = openSlotOn(clockFor(settings, now, null), BACKUP_TIME);
    if (!slot || slot.weekday !== BACKUP_DAY) return;

    const weekKey = weekKeyOfDay(slot.dateKey);
    if (settingsRepo.getKV(KV_LAST_BACKUP_WEEK) === weekKey) return;
    settingsRepo.setKV(KV_LAST_BACKUP_WEEK, weekKey);

    const snap = runBackup("weekly");
    await sendPushToAll(
      {
        title: "Weekly backup ready",
        body: `${Math.max(1, Math.round(snap.bytes / 1024))} KB saved. Tap to keep a copy off the server.`,
        url: "/settings/backups",
        tag: "backup-weekly",
      },
      ["owner"],
    );
  } catch (err) {
    console.error("[scheduler] weekly backup", err);
  }
}

// ── 3. Weekly review ───────────────────────────────────────────────────────

async function runWeeklyReview(settings: AppSettings, now: Date): Promise<void> {
  try {
    if (!settings.notifications.weeklyReviewEnabled) return;

    const weeklyDay = settings.notifications.weeklyDay;
    const slot = openSlotOn(clockFor(settings, now, null), settings.notifications.weeklyTime);
    if (!slot || slot.weekday !== weeklyDay) return;
    const dateLocal = slot.dateKey;

    // Sunday reviews the week ending today; any other day, the last week to
    // have finished — never the one that has only just begun.
    const week = reviewedWeek(dateLocal);
    const weekKey = week.weekKey;
    // The old key named the week the send fell in, which is the same week
    // only on a Sunday; any other day it would skip one review on upgrade.
    const last =
      settingsRepo.getKV(KV_LAST_REVIEWED_WEEK) ??
      (weeklyDay === 0 ? settingsRepo.getKV(KV_LAST_REVIEW_WEEK) : null);
    if (last === weekKey) return;
    settingsRepo.setKV(KV_LAST_REVIEWED_WEEK, weekKey);

    let review: WeeklyReview | null = null;
    if (aiConfigured()) {
      try {
        // Always fresh: a visit to the Review page earlier in the week saves
        // a review of the days so far, which is not the week's review.
        review = await generateWeeklyReview(weekKey, { force: true });
      } catch (err) {
        console.error("[scheduler] review generation", err);
      }
    }

    const completed = review?.completedCount ?? completionsRepo.countRange(week.from, week.to);
    const span = week.to === dateLocal ? "this week" : "last week";
    await sendPushToAll(
      {
        title: "Your week in review",
        body: firstSentence(review?.narrative) || `${completed} task(s) completed ${span}.`,
        url: `/review?week=${weekKey}`,
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
    // The latest slot still inside its catch-up window, if any.
    const home = clockFor(settings, now, null);
    const slot = [...TRIAGE_TIMES].reverse().find((t) => openSlotOn(home, t));
    const open = slot ? openSlotOn(home, slot) : null;
    if (!slot || !open) return;

    const slotKey = `${open.dateKey}@${slot}`;
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
      // Credit triage only with what it did itself; the user may have settled
      // an item while the model was thinking.
      if (after.status === "resolved" && after.suggestion?.updatedTaskTitle) updated += 1;
      else if (after.status === "dismissed" && after.suggestion?.autoDismissed) dismissed += 1;
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

/** Same moment, whatever ISO form each was written in. */
function sameInstant(a: string | null, b: string | null): boolean {
  if (!a || !b) return !a && !b;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isNaN(ta) || Number.isNaN(tb) ? a === b : ta === tb;
}

/** A nudge slot noted as tried without reaching anyone: "YYYY-MM-DD#<tries>@<epoch ms>". */
function failedNudge(stored: string | null, dateKey: string): { count: number; at: number } | null {
  const m = /^(\d{4}-\d{2}-\d{2})#(\d+)@(\d+)$/.exec(stored ?? "");
  if (!m || m[1] !== dateKey) return null;
  return { count: Number(m[2]), at: Number(m[3]) };
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
