import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent } from "@/lib/types";

// A throwaway data directory per run, so the real one is never touched.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "donex-scheduler-"));
process.env.DATA_DIR = DIR;

/** Everything the scheduler reaches outside the database, faked and recorded. */
const fake = vi.hoisted(() => ({
  sent: [] as { title: string; body: string; url?: string; tag?: string; roles?: string[] }[],
  /** what sendPushToAll reports as delivered */
  delivered: 1,
  onSend: null as null | ((title: string) => void),
  ai: false,
  reviews: [] as { weekKey: string; force?: boolean }[],
  briefings: [] as { dateLocal: string; force?: boolean; awayOffsetMinutes?: number | null }[],
  feed: { events: [] as CalendarEvent[], warning: null as string | null },
}));

vi.mock("@/lib/push", () => ({
  hasPushSubscriptions: () => true,
  sendPushToAll: async (
    payload: { title: string; body: string; url?: string; tag?: string },
    roles?: string[],
  ) => {
    fake.sent.push({ ...payload, roles });
    fake.onSend?.(payload.title);
    return fake.delivered;
  },
}));

vi.mock("@/lib/ai", () => ({
  aiConfigured: () => fake.ai,
  generateBriefing: async (
    dateLocal: string,
    opts: { force?: boolean; awayOffsetMinutes?: number | null } = {},
  ) => {
    fake.briefings.push({ dateLocal, ...opts });
    return {
      dateLocal,
      greeting: "Morning",
      narrative: "Plenty on.",
      focusTaskIds: [],
      generatedAt: new Date().toISOString(),
    };
  },
  // Empty means nothing to say, which keeps digests out of these tests.
  generateJointDigest: async () => "",
  generateWeeklyReview: async (weekKey: string, opts?: { force?: boolean }) => {
    fake.reviews.push({ weekKey, force: opts?.force });
    return {
      weekKey,
      completedCount: 4,
      createdCount: 0,
      streak: 0,
      bestDay: null,
      narrative: "A steady week. More below.",
      suggestions: [],
      generatedAt: new Date().toISOString(),
    };
  },
  refreshFallbackModel: async () => undefined,
  sweepAutoDismissable: () => 0,
  triageInboxItem: async () => undefined,
}));

vi.mock("@/lib/google/gmail", () => ({ scanGmail: async () => 0 }));

vi.mock("@/lib/jointFeeds", async () => {
  const { detectTrips } = await import("@/lib/trips");
  const { addDaysToDateKey, isoFromLocal, localDateKey } = await import("@/lib/utils");
  // Like the real feed: only what overlaps the window asked for, nothing on a failure.
  const ownerEvents = async (_joint: unknown, w: { fromIso: string; toIso: string }) => ({
    events: fake.feed.warning
      ? []
      : fake.feed.events.filter(
          (e) => Date.parse(e.end) >= Date.parse(w.fromIso) && Date.parse(e.start) < Date.parse(w.toIso),
        ),
    source: "google-own",
    warning: fake.feed.warning,
  });
  return {
    ownerEvents,
    partnerEvents: async () => ({ events: [], source: "none", warning: null }),
    // The real window: 30 days back, 45 ahead, in the user's tz.
    ownerTrips: async (settings: { tz: string; joint: unknown }, now: Date = new Date()) => {
      const tz = settings.tz;
      const today = localDateKey(now, tz);
      const { events, warning } = await ownerEvents(settings.joint, {
        fromIso: isoFromLocal(addDaysToDateKey(today, -30), "00:00", tz),
        toIso: isoFromLocal(addDaysToDateKey(today, 45), "00:00", tz),
      });
      return { trips: detectTrips(events, { tz, now }), warning };
    },
  };
});

vi.mock("@/lib/backup", () => ({
  runBackup: () => ({ name: "snap", createdAt: "", kind: "weekly", bytes: 4096, counts: {} }),
}));

vi.mock("@/lib/weekAheadStore", () => ({
  buildWeekAhead: async () => ({ text: "A busy week.", weekOf: "" }),
  kvLastWeekAheadWeek: (role: string) => `sched.lastWeekAhead.${role}`,
}));

const { getDb } = await import("@/lib/db");
const { briefingsRepo, projectsRepo, settingsRepo, tasksRepo } = await import("@/lib/db/repos");
let scheduler = await import("@/lib/scheduler");

/** A fresh process: module state (the trip cache, the tick lock) gone, the database kept. */
async function restart(): Promise<void> {
  vi.resetModules();
  scheduler = await import("@/lib/scheduler");
}

/** One tick at a moment in time. vitest runs in UTC here, like the server. */
async function tickAt(iso: string): Promise<void> {
  vi.setSystemTime(new Date(iso));
  await scheduler.tick();
}

const sentWhere = (test: (s: (typeof fake.sent)[number]) => boolean) => fake.sent.filter(test);
const briefings = () => sentWhere((s) => s.title === "Good morning ☀️" || s.title === "Morning");

/** Everything quiet; each test turns on what it is about. */
function baseline(): void {
  settingsRepo.updateApp({
    tz: "America/New_York",
    notifications: {
      remindersEnabled: false,
      briefingEnabled: false,
      briefingTime: "07:00",
      weeklyReviewEnabled: false,
      weeklyDay: 0,
      weeklyTime: "18:00",
    },
    joint: {
      partnerPinHash: "",
      ownerDigestEnabled: false,
      partnerDigestEnabled: false,
      ownerWeekAheadEnabled: false,
      partnerWeekAheadEnabled: false,
      nudgeEnabled: false,
      nudgeTime: "18:00",
    },
  });
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterAll(() => {
  vi.useRealTimers();
  fs.rmSync(DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'sched.%'").run();
  getDb().prepare("DELETE FROM tasks").run();
  getDb().prepare("DELETE FROM briefings").run();
  fake.sent = [];
  fake.reviews = [];
  fake.briefings = [];
  fake.delivered = 1;
  fake.onSend = null;
  fake.ai = false;
  fake.feed = { events: [], warning: null };
  baseline();
  await restart();
});

describe("catching up a missed minute", () => {
  beforeEach(() => {
    settingsRepo.updateApp({ notifications: { briefingEnabled: true, briefingTime: "07:00" } });
  });

  it("sends on a late tick, once, and not again after a restart", async () => {
    await tickAt("2026-10-27T11:04:00Z"); // 7:04 AM EDT: 7:00 to 7:03 were skipped
    expect(briefings()).toHaveLength(1);

    await tickAt("2026-10-27T11:05:00Z");
    expect(briefings()).toHaveLength(1);

    await restart();
    await tickAt("2026-10-27T11:06:00Z");
    expect(briefings()).toHaveLength(1);
  });

  it("lets the day's send go once its window has passed", async () => {
    await tickAt("2026-10-27T13:30:00Z"); // 9:30 AM EDT
    expect(briefings()).toHaveLength(0);
    await tickAt("2026-10-28T11:00:00Z"); // next morning, on the minute
    expect(briefings()).toHaveLength(1);
  });

  it("sends a 2:30 AM job on the morning daylight time skips 2:30", async () => {
    settingsRepo.updateApp({ notifications: { briefingTime: "02:30" } });
    await tickAt("2026-03-08T07:00:00Z"); // 3:00 AM EDT, the minute after 1:59 AM EST
    expect(briefings()).toHaveLength(1);
  });

  it("sends a 1:30 AM job once on the night 1:30 happens twice", async () => {
    settingsRepo.updateApp({ notifications: { briefingTime: "01:30" } });
    await tickAt("2026-11-01T05:35:00Z"); // 1:35 AM EDT
    await tickAt("2026-11-01T06:35:00Z"); // 1:35 AM EST, an hour later
    expect(briefings()).toHaveLength(1);
  });

  it("catches a late-evening slot after midnight, as the evening before's", async () => {
    settingsRepo.updateApp({ notifications: { briefingTime: "23:30" } });
    await tickAt("2026-10-28T04:10:00Z"); // 12:10 AM EDT Wednesday
    expect(briefings()).toHaveLength(1);
    expect(settingsRepo.getKV("sched.lastBriefingDay")).toBe("2026-10-27");
    await tickAt("2026-10-28T04:20:00Z");
    expect(briefings()).toHaveLength(1);
  });

  it("decides a slot caught after midnight on its own day's rules", async () => {
    settingsRepo.updateApp({
      notifications: { briefingEnabled: false },
      joint: { ownerDigestEnabled: true, ownerDigestTime: "23:30" },
    });
    // Saturday's 11:30 PM digest, caught at 12:10 AM Sunday: Saturday's, so it goes.
    await tickAt("2026-10-25T04:10:00Z");
    expect(settingsRepo.getKV("sched.lastJointDigest.owner")).toBe("2026-10-24");
    // Sunday's, caught at 12:10 AM Monday: Sundays are skipped.
    await tickAt("2026-10-26T04:10:00Z");
    expect(settingsRepo.getKV("sched.lastJointDigest.owner")).toBe("2026-10-24");
  });

  it("keeps a briefing the user made after the slot, however late the tick", async () => {
    fake.ai = true;
    const made = (iso: string) =>
      briefingsRepo.save({
        dateLocal: "2026-10-27",
        greeting: "Hi",
        narrative: "Read already.",
        focusTaskIds: [],
        generatedAt: iso,
      });
    made("2026-10-27T11:05:00Z"); // opened Today at 7:05 AM EDT, after the 7:00 slot
    await tickAt("2026-10-27T12:10:00Z"); // a catch-up tick at 8:10
    expect(fake.briefings).toEqual([
      { dateLocal: "2026-10-27", force: false, awayOffsetMinutes: null },
    ]);
  });

  it("makes the briefing again when the saved one is from the small hours", async () => {
    fake.ai = true;
    briefingsRepo.save({
      dateLocal: "2026-10-27",
      greeting: "Hi",
      narrative: "Made at 4 AM.",
      focusTaskIds: [],
      generatedAt: "2026-10-27T08:00:00Z", // 4:00 AM EDT
    });
    await tickAt("2026-10-27T11:02:00Z");
    expect(fake.briefings.map((b) => b.force)).toEqual([true]);
  });
});

describe("Sunday evening in New York", () => {
  beforeEach(() => {
    fake.ai = true;
    settingsRepo.updateApp({
      notifications: { weeklyReviewEnabled: true, weeklyDay: 0, weeklyTime: "18:00" },
      joint: { ownerWeekAheadEnabled: true, ownerWeekAheadTime: "18:00" },
    });
  });

  it("sends the week ahead and a freshly written review of the week ending today", async () => {
    await tickAt("2026-10-25T22:07:00Z"); // Sun 6:07 PM EDT
    expect(sentWhere((s) => s.tag === "week-ahead-2026-W43")).toHaveLength(1);
    expect(fake.reviews).toEqual([{ weekKey: "2026-W43", force: true }]);
    const [review] = sentWhere((s) => s.title === "Your week in review");
    expect(review.url).toBe("/review?week=2026-W43");
    expect(review.body).toBe("A steady week.");
  });

  it("takes the weekly backup at 9 PM, when UTC is already Monday, once", async () => {
    await tickAt("2026-10-26T01:10:00Z"); // Sun 9:10 PM EDT
    await tickAt("2026-10-26T01:20:00Z");
    const backups = sentWhere((s) => s.tag === "backup-weekly");
    expect(backups).toHaveLength(1);
    expect(backups[0].url).toBe("/settings/backups");
  });
});

describe("a weekly review set for Monday", () => {
  beforeEach(() => {
    settingsRepo.updateApp({
      notifications: { weeklyReviewEnabled: true, weeklyDay: 1, weeklyTime: "09:00" },
    });
  });

  it("reviews the week just gone, not the one that began this morning", async () => {
    fake.ai = true;
    await tickAt("2026-10-26T13:10:00Z"); // Mon 9:10 AM EDT
    expect(fake.reviews).toEqual([{ weekKey: "2026-W43", force: true }]);
    expect(sentWhere((s) => s.title === "Your week in review")[0].url).toBe(
      "/review?week=2026-W43",
    );
  });

  it("says last week when it has no model to write it", async () => {
    await tickAt("2026-10-26T13:10:00Z");
    expect(sentWhere((s) => s.title === "Your week in review")[0].body).toBe(
      "0 task(s) completed last week.",
    );
  });

  it("doesn't skip a review on upgrade because the old key named a different week", async () => {
    // Before, Monday 2026-10-26's send stored the week it fell in: W44.
    settingsRepo.setKV("sched.lastReviewWeek", "2026-W44");
    await tickAt("2026-11-02T14:10:00Z"); // Mon 9:10 AM EST, reviewing W44
    expect(sentWhere((s) => s.url === "/review?week=2026-W44")).toHaveLength(1);
    expect(settingsRepo.getKV("sched.lastReviewedWeek")).toBe("2026-W44");
  });

  it("doesn't send again when a deploy lands just after the old build's Monday send", async () => {
    settingsRepo.updateApp({ notifications: { weeklyTime: "20:00" } });
    // The old build sent at 8 PM Monday 2026-10-26 and stored the week it fell in.
    settingsRepo.setKV("sched.lastReviewWeek", "2026-W44");
    await tickAt("2026-10-27T01:30:00Z"); // 9:30 PM EDT, inside the window
    expect(sentWhere((s) => s.title === "Your week in review")).toHaveLength(0);
  });

  it("still honours the old key on a Sunday, where it meant the same week", async () => {
    settingsRepo.updateApp({ notifications: { weeklyDay: 0, weeklyTime: "18:00" } });
    settingsRepo.setKV("sched.lastReviewWeek", "2026-W43");
    await tickAt("2026-10-25T22:10:00Z"); // Sun 6:10 PM EDT
    expect(sentWhere((s) => s.title === "Your week in review")).toHaveLength(0);
  });
});

describe("nudges at 6 PM", () => {
  beforeEach(() => {
    settingsRepo.updateApp({
      joint: { partnerPinHash: "set", nudgeEnabled: true, nudgeTime: "18:00", ownerName: "Sam" },
    });
    // Tagged for the partner by the owner; all-day, due Tue 2026-12-01 (EST midnight).
    tasksRepo.create(
      {
        title: "renew the permit",
        space: "joint",
        assignedTo: "partner",
        dueAt: "2026-12-01T05:00:00.000Z",
        allDay: true,
      },
      "owner",
    );
  });
  const nudges = () => sentWhere((s) => s.title.startsWith("Still open"));

  it("waits for the due day to end in New York, not in UTC", async () => {
    await tickAt("2026-12-02T00:30:00Z"); // Tue 7:30 PM EST, already Wednesday in UTC
    expect(nudges()).toHaveLength(0);

    await tickAt("2026-12-02T23:10:00Z"); // Wed 6:10 PM EST
    expect(nudges()).toHaveLength(1);
    expect(nudges()[0].body).toContain("it was due yesterday");
    expect(nudges()[0].roles).toEqual(["partner"]);
  });

  it("marks nothing when nothing was delivered, and tries again a while later", async () => {
    fake.delivered = 0;
    await tickAt("2026-12-02T23:10:00Z"); // 6:10 PM EST
    expect(nudges()).toHaveLength(1);
    expect(tasksRepo.nudgeState().size).toBe(0);

    fake.delivered = 1;
    await tickAt("2026-12-02T23:20:00Z"); // too soon to try again
    expect(nudges()).toHaveLength(1);
    await tickAt("2026-12-02T23:41:00Z");
    expect(nudges()).toHaveLength(2);
    expect(tasksRepo.nudgeState().size).toBe(1);

    await tickAt("2026-12-03T00:30:00Z");
    expect(nudges()).toHaveLength(2);
  });

  it("gives up for the day after a few tries that reach nobody", async () => {
    fake.delivered = 0;
    for (let minute = 0; minute < 120; minute += 5) {
      const at = new Date(Date.parse("2026-12-02T23:00:00Z") + minute * 60_000);
      await tickAt(at.toISOString()); // every five minutes, 6:00 to 7:55 PM EST
    }
    expect(nudges()).toHaveLength(3);
    expect(tasksRepo.nudgeState().size).toBe(0);
  });
});

describe("reminders", () => {
  beforeEach(() => {
    settingsRepo.updateApp({ notifications: { remindersEnabled: true } });
  });
  const reminders = () => sentWhere((s) => s.title.startsWith("⏰"));
  const NOW = "2026-10-27T22:00:00Z";
  const minutesAgo = (n: number) => new Date(Date.parse(NOW) - n * 60_000).toISOString();

  it("keeps the owner's project names off joint reminders", async () => {
    const project = projectsRepo.create({ name: "Job search - Acme" });
    const due = { projectId: project.id, dueAt: minutesAgo(1) };
    tasksRepo.create({ title: "dinner reservation", space: "joint", ...due });
    tasksRepo.create({ title: "send the cover letter", ...due });
    settingsRepo.updateApp({ joint: { partnerPinHash: "set" } });

    await tickAt(NOW);
    const joint = reminders().find((s) => s.title.includes("dinner"));
    const mine = reminders().find((s) => s.title.includes("cover letter"));
    expect(joint?.body).not.toContain("Job search");
    expect(joint?.roles).toBeUndefined();
    expect(mine?.body).toContain("Job search - Acme");
    expect(mine?.roles).toEqual(["owner"]);
  });

  it("sends a joint reminder only to the owner while partner access is off", async () => {
    tasksRepo.create({ title: "water the plants", space: "joint", dueAt: minutesAgo(1) });
    await tickAt(NOW);
    expect(reminders()[0].roles).toEqual(["owner"]);
  });

  it("lets a stale backlog go quietly instead of sending a burst ahead of what is due now", async () => {
    for (let i = 0; i < 25; i++) {
      tasksRepo.create({ title: `old ${i}`, dueAt: minutesAgo(3 * 24 * 60 + i) });
    }
    tasksRepo.create({ title: "due now", dueAt: minutesAgo(1) });

    await tickAt(NOW);
    expect(reminders().map((s) => s.title)).toEqual(["⏰ due now"]);
    expect(tasksRepo.dueForReminder(NOW)).toEqual([]);
  });

  it("leaves the rest of a batch unclaimed when sending stops part way", async () => {
    tasksRepo.create({ title: "first", dueAt: minutesAgo(3) });
    tasksRepo.create({ title: "second", dueAt: minutesAgo(2) });
    tasksRepo.create({ title: "third", dueAt: minutesAgo(1) });
    fake.onSend = () => {
      fake.onSend = null;
      throw new Error("the process went away");
    };

    await tickAt(NOW);
    expect(tasksRepo.dueForReminder(NOW).map((t) => t.title)).toEqual(["second", "third"]);
    await tickAt(NOW);
    expect(reminders().map((s) => s.title)).toEqual(["⏰ first", "⏰ second", "⏰ third"]);
  });

  it("still sends when the due time was rewritten as the same moment mid-batch", async () => {
    tasksRepo.create({ title: "first", dueAt: minutesAgo(2) });
    const second = tasksRepo.create({ title: "second", dueAt: minutesAgo(1) });
    fake.onSend = () => {
      fake.onSend = null;
      // Same instant, written without milliseconds.
      tasksRepo.update(second.id, { dueAt: minutesAgo(1).replace(".000Z", "Z") });
    };

    await tickAt(NOW);
    expect(reminders().map((s) => s.title)).toEqual(["⏰ first", "⏰ second"]);
  });

  it("doesn't mark a task rescheduled while its reminder was being sent", async () => {
    const task = tasksRepo.create({ title: "call the bank", dueAt: minutesAgo(1) });
    const later = "2026-10-28T15:00:00.000Z";
    fake.onSend = () => {
      fake.onSend = null;
      tasksRepo.update(task.id, { dueAt: later });
    };

    await tickAt(NOW);
    expect(reminders()).toHaveLength(1);
    // The new time still has its reminder to come.
    expect(tasksRepo.dueForReminder(later).map((t) => t.id)).toEqual([task.id]);
  });
});

describe("on a trip", () => {
  // Home is New York; the owner is in Honolulu (UTC-10) from Oct 20 to Nov 3.
  const HAWAII: CalendarEvent[] = [
    {
      id: "out",
      title: "Flight to Honolulu — Hawaiian HA 51 (JFK → HNL)",
      start: "2026-10-20T08:00:00-04:00",
      end: "2026-10-20T13:30:00-10:00",
      allDay: false,
      location: null,
    },
    {
      id: "stay",
      title: "Hotel — Hilton Hawaiian Village",
      start: "2026-10-20T15:00:00-10:00",
      end: "2026-11-03T11:00:00-10:00",
      allDay: false,
      location: null,
    },
    {
      id: "back",
      title: "Flight to New York — Hawaiian HA 50 (HNL → JFK)",
      start: "2026-11-03T15:00:00-10:00",
      end: "2026-11-04T06:00:00-05:00",
      allDay: false,
      location: null,
    },
  ];

  it("isn't skipped the next Sunday by a key the old build wrote from a trip", async () => {
    settingsRepo.updateApp({ joint: { ownerWeekAheadEnabled: true, ownerWeekAheadTime: "18:00" } });
    // Sun Oct 25 6 PM in Honolulu was Mon at home: the old build stored W44.
    settingsRepo.setKV("sched.lastWeekAhead.owner", "2026-W44");
    settingsRepo.setKV(
      "joint.weekAhead.owner",
      JSON.stringify({ text: "Last week's.", weekOf: "2026-10-26", at: "2026-10-26T04:00:00Z" }),
    );
    await tickAt("2026-11-01T23:05:00Z"); // Sun Nov 1, 6:05 PM EST, back home
    expect(sentWhere((s) => s.tag === "week-ahead-2026-W44")).toHaveLength(1);
    expect(settingsRepo.getKV("sched.weekAheadWeek.owner")).toBe("2026-W44");
  });

  it("trusts the old key when the old build sent this very Sunday", async () => {
    settingsRepo.updateApp({ joint: { ownerWeekAheadEnabled: true, ownerWeekAheadTime: "18:00" } });
    settingsRepo.setKV("sched.lastWeekAhead.owner", "2026-W44");
    settingsRepo.setKV(
      "joint.weekAhead.owner",
      JSON.stringify({ text: "This week's.", weekOf: "2026-11-02", at: "2026-11-01T23:00:00Z" }),
    );
    await tickAt("2026-11-01T23:30:00Z"); // a deploy half an hour after it went out
    expect(sentWhere((s) => s.title === "The week ahead")).toHaveLength(0);
  });

  it("keys the week ahead to the week where the owner is", async () => {
    fake.feed.events = HAWAII;
    settingsRepo.updateApp({
      joint: { ownerWeekAheadEnabled: true, ownerWeekAheadTime: "18:00" },
    });

    // Sun 6:05 PM in Honolulu is already Monday (W44) at home.
    await tickAt("2026-10-26T04:05:00Z");
    expect(sentWhere((s) => s.tag === "week-ahead-2026-W43")).toHaveLength(1);
    expect(settingsRepo.getKV("sched.lastWeekAhead.owner")).toBe("2026-W43");
  });

  it("tells the briefing where you woke up", async () => {
    fake.ai = true;
    fake.feed.events = HAWAII;
    settingsRepo.updateApp({ notifications: { briefingEnabled: true, briefingTime: "07:00" } });
    await tickAt("2026-10-27T17:05:00Z"); // 7:05 AM in Honolulu, a week into the trip
    expect(fake.briefings).toEqual([
      { dateLocal: "2026-10-27", force: false, awayOffsetMinutes: -600 },
    ]);
  });

  it("holds the owner's jobs after a restart until the calendar has been read once", async () => {
    fake.feed = { events: [], warning: "Google Calendar is unreachable right now." };
    settingsRepo.updateApp({ notifications: { briefingEnabled: true, briefingTime: "07:00" } });

    await tickAt("2026-10-27T11:05:00Z"); // 7:05 AM in New York: where is the owner?
    expect(briefings()).toHaveLength(0);
    await tickAt("2026-10-27T11:25:00Z");
    expect(briefings()).toHaveLength(0);

    // Half an hour of failures: home time it is.
    await tickAt("2026-10-27T11:40:00Z");
    expect(briefings()).toHaveLength(1);
  });

  it("sends on the first good read, if that comes inside the window", async () => {
    fake.feed = { events: [], warning: "Google Calendar is unreachable right now." };
    settingsRepo.updateApp({ notifications: { briefingEnabled: true, briefingTime: "07:00" } });
    await tickAt("2026-10-27T11:05:00Z");
    fake.feed = { events: [], warning: null };
    await tickAt("2026-10-27T11:12:00Z"); // retried after five minutes; home, as it turns out
    expect(briefings()).toHaveLength(1);
  });

  it("stays on trip time when the calendar can't be read", async () => {
    fake.feed.events = HAWAII;
    settingsRepo.updateApp({ notifications: { briefingEnabled: true, briefingTime: "07:00" } });
    await tickAt("2026-10-27T09:00:00Z"); // 11 PM Mon in Honolulu: trip found

    fake.feed = { events: [], warning: "Google Calendar is unreachable right now." };
    await tickAt("2026-10-27T11:05:00Z"); // 7:05 AM in New York, 1:05 AM in Honolulu
    expect(briefings()).toHaveLength(0);

    await tickAt("2026-10-27T17:05:00Z"); // 7:05 AM in Honolulu
    expect(briefings()).toHaveLength(1);
    expect(settingsRepo.getKV("sched.lastBriefingDay")).toBe("2026-10-27");
  });
});
