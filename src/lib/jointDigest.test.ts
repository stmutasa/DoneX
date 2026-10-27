import { describe, expect, it } from "vitest";
import {
  CATCH_UP_MINUTES,
  clockLabel,
  digestLines,
  fallbackDigest,
  isValidTime,
  normalizeTime,
  openSlot,
  shouldSendDigest,
  slotOpen,
  splitForDigest,
  tasksForPerson,
} from "@/lib/jointDigest";
import type { Task } from "@/lib/types";

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: Math.random().toString(36).slice(2),
    title: "a shared job",
    notes: "",
    status: "open",
    space: "joint",
    createdBy: "owner",
    assignedTo: null,
    priority: 0,
    dueAt: null,
    dueKind: "on",
    allDay: false,
    projectId: null,
    tags: [],
    parentId: null,
    recurrence: null,
    location: null,
    sort: 0,
    completedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  }) as Task;

describe("tasksForPerson", () => {
  const tasks = [
    task({ title: "mine", assignedTo: "owner" }),
    task({ title: "hers", assignedTo: "partner" }),
    task({ title: "either of us", assignedTo: null }),
  ];

  it("gives the owner their own and the unclaimed, never hers", () => {
    expect(tasksForPerson(tasks, "owner").map((t) => t.title)).toEqual(["mine", "either of us"]);
  });

  it("gives the partner hers and the unclaimed, never his", () => {
    expect(tasksForPerson(tasks, "partner").map((t) => t.title)).toEqual(["hers", "either of us"]);
  });

  it("leaves out finished work", () => {
    const done = [...tasks, task({ title: "already done", assignedTo: "owner", status: "done" })];
    expect(tasksForPerson(done, "owner").map((t) => t.title)).not.toContain("already done");
  });

  it("leaves out subtasks and anything personal", () => {
    const mixed = [
      task({ title: "subtask", assignedTo: "owner", parentId: "p1" }),
      task({ title: "personal", assignedTo: "owner", space: "personal" }),
      task({ title: "kept", assignedTo: "owner" }),
    ];
    expect(tasksForPerson(mixed, "owner").map((t) => t.title)).toEqual(["kept"]);
  });
});

describe("splitForDigest", () => {
  it("separates what is yours from what is nobody's yet", () => {
    const { mine, ours } = splitForDigest(
      [
        task({ title: "mine", assignedTo: "owner" }),
        task({ title: "hers", assignedTo: "partner" }),
        task({ title: "shared", assignedTo: null }),
      ],
      "owner",
    );
    expect(mine.map((t) => t.title)).toEqual(["mine"]);
    expect(ours.map((t) => t.title)).toEqual(["shared"]);
  });
});

describe("shouldSendDigest", () => {
  const base = {
    schedule: { enabled: true, time: "07:00" },
    nowTime: "07:00",
    weekday: 1,
    today: "2026-09-14",
    lastSent: null,
  };

  it("sends at the configured minute", () => {
    expect(shouldSendDigest(base)).toBe(true);
  });

  it("still sends on a late or skipped tick inside the catch-up window", () => {
    expect(shouldSendDigest({ ...base, nowTime: "07:01" })).toBe(true);
    expect(shouldSendDigest({ ...base, nowTime: "08:59" })).toBe(true);
  });

  it("stays quiet before its minute and once the window has passed", () => {
    expect(shouldSendDigest({ ...base, nowTime: "06:59" })).toBe(false);
    expect(shouldSendDigest({ ...base, nowTime: "09:00" })).toBe(false);
    expect(shouldSendDigest({ ...base, nowTime: "10:00" })).toBe(false);
  });

  it("doesn't send twice when a late tick finds today already claimed", () => {
    expect(shouldSendDigest({ ...base, nowTime: "07:30", lastSent: "2026-09-14" })).toBe(false);
  });

  it("never sends on a Sunday", () => {
    expect(shouldSendDigest({ ...base, weekday: 0 })).toBe(false);
  });

  it("sends on a Saturday", () => {
    expect(shouldSendDigest({ ...base, weekday: 6 })).toBe(true);
  });

  it("stays quiet when that person turned it off", () => {
    expect(shouldSendDigest({ ...base, schedule: { enabled: false, time: "07:00" } })).toBe(false);
  });

  it("sends only once a day", () => {
    expect(shouldSendDigest({ ...base, lastSent: "2026-09-14" })).toBe(false);
    expect(shouldSendDigest({ ...base, lastSent: "2026-09-13" })).toBe(true);
  });

  it("treats 7:00 and 07:00 as the same minute", () => {
    expect(shouldSendDigest({ ...base, schedule: { enabled: true, time: "7:0" } })).toBe(true);
  });

  it("lets the two people run at different times", () => {
    const hers = { ...base, schedule: { enabled: true, time: "10:00" } };
    expect(shouldSendDigest({ ...hers, nowTime: "10:00" })).toBe(true);
    expect(shouldSendDigest({ ...hers, nowTime: "07:00" })).toBe(false);
    expect(shouldSendDigest({ ...base, nowTime: "10:00" })).toBe(false);
  });
});

describe("fallbackDigest", () => {
  it("counts what is yours and what is unclaimed", () => {
    const text = fallbackDigest({
      mine: [task({ title: "call the vet", assignedTo: "owner" })],
      ours: [task({ title: "book the table" }), task({ title: "water plants" })],
      partnerName: "Annette",
    });
    expect(text).toContain("1 for you");
    expect(text).toContain("2 unclaimed");
    expect(text).toContain("call the vet");
  });

  it("flags overdue work", () => {
    const text = fallbackDigest({
      mine: [task({ title: "late thing", assignedTo: "owner", dueAt: "2020-01-01T10:00:00.000Z" })],
      ours: [],
      partnerName: "Annette",
    });
    expect(text).toContain("1 overdue");
  });

  it("says so plainly when there is nothing", () => {
    expect(fallbackDigest({ mine: [], ours: [], partnerName: "Annette" })).toBe(
      "Nothing on the shared list",
    );
  });
});

describe("time helpers", () => {
  it("normalises loose input", () => {
    expect(normalizeTime("7:0")).toBe("07:00");
    expect(normalizeTime("23:9")).toBe("23:09");
    expect(normalizeTime("nonsense")).toBe("00:00");
  });

  it("validates what a user can type", () => {
    expect(isValidTime("07:00")).toBe(true);
    expect(isValidTime("7:00")).toBe(true);
    expect(isValidTime("24:00")).toBe(false);
    expect(isValidTime("07:60")).toBe(false);
    expect(isValidTime("")).toBe(false);
  });

  it("reads back in 12-hour time", () => {
    expect(clockLabel("07:00")).toBe("7:00 AM");
    expect(clockLabel("10:00")).toBe("10:00 AM");
    expect(clockLabel("00:30")).toBe("12:30 AM");
    expect(clockLabel("13:05")).toBe("1:05 PM");
  });
});

describe("slotOpen", () => {
  it("opens at the minute and stays open for the catch-up window", () => {
    expect(CATCH_UP_MINUTES).toBe(120);
    expect(slotOpen("18:00", "18:00")).toBe(true);
    expect(slotOpen("19:59", "18:00")).toBe(true);
    expect(slotOpen("20:00", "18:00")).toBe(false);
    expect(slotOpen("17:59", "18:00")).toBe(false);
  });

  it("gives a late-evening slot its whole window, past midnight, as the day before's", () => {
    expect(openSlot("23:59", "23:30")).toEqual({ minutesIn: 29, dayOffset: 0 });
    expect(openSlot("00:10", "23:30")).toEqual({ minutesIn: 40, dayOffset: -1 });
    expect(openSlot("01:30", "23:30")).toBeNull();
    // An early slot never reaches back to the evening before.
    expect(openSlot("06:59", "07:00")).toBeNull();
  });

  it("says how long ago the slot opened", () => {
    expect(openSlot("08:10", "07:00")).toEqual({ minutesIn: 70, dayOffset: 0 });
  });

  it("catches a slot the clocks skip at the start of daylight time", () => {
    // 02:30 never happens on the spring-forward morning; 03:00 is the next minute.
    expect(slotOpen("03:00", "02:30")).toBe(true);
  });

  it("reads loose input and refuses nonsense", () => {
    expect(slotOpen("07:05", "7:0")).toBe(true);
    expect(slotOpen("00:05", "nonsense")).toBe(false);
    expect(slotOpen("00:05", "")).toBe(false);
  });
});

describe("digestLines in the user's timezone", () => {
  // vitest runs in UTC here, like the server. The user is in New York.
  const TZ = "America/New_York";
  const MORNING = new Date("2026-10-27T11:00:00Z"); // Tue 7:00 AM EDT
  const EVENING = new Date("2026-10-27T22:00:00Z"); // Tue 6:00 PM EDT

  it("writes due times on the user's clock, not the server's", () => {
    const lines = digestLines(
      [
        task({ title: "pick up the cake", dueAt: "2026-10-27T19:00:00.000Z" }), // 3:00 PM EDT
        task({ title: "call grandma", dueAt: "2026-10-28T01:00:00.000Z" }), // 9:00 PM EDT
      ],
      TZ,
      MORNING,
    );
    expect(lines).toEqual(["- pick up the cake (Today 3:00 PM)", "- call grandma (Today 9:00 PM)"]);
  });

  it("calls tomorrow evening tomorrow, even though it is the day after in UTC", () => {
    const [line] = digestLines(
      [task({ title: "dinner", dueAt: "2026-10-29T01:00:00.000Z" })], // Wed 9:00 PM EDT
      TZ,
      MORNING,
    );
    expect(line).toBe("- dinner (Tomorrow 9:00 PM)");
  });

  it("doesn't mark today's all-day task overdue once UTC has rolled over", () => {
    // Stored as local midnight: 2026-10-27 00:00 EDT.
    const today = task({ title: "recycling out", dueAt: "2026-10-27T04:00:00.000Z", allDay: true });
    const lateEvening = new Date("2026-10-28T00:30:00Z"); // 8:30 PM EDT, already Wednesday in UTC
    expect(digestLines([today], TZ, lateEvening)).toEqual(["- recycling out (Today)"]);
    expect(digestLines([today], TZ, EVENING)).toEqual(["- recycling out (Today)"]);
  });

  it("does mark yesterday's all-day task overdue", () => {
    const yesterday = task({ title: "rsvp", dueAt: "2026-10-26T04:00:00.000Z", allDay: true });
    expect(digestLines([yesterday], TZ, MORNING)).toEqual(["- rsvp (OVERDUE · Overdue · 1d)"]);
  });

  it("keeps the day whole across the end of daylight time", () => {
    // Sunday 2026-11-01: midnight EDT is 04:00Z; the day ends at midnight EST, 05:00Z.
    const sunday = task({ title: "clocks back", dueAt: "2026-11-01T04:00:00.000Z", allDay: true });
    const lateSunday = new Date("2026-11-02T04:30:00Z"); // 11:30 PM EST, still Sunday
    expect(digestLines([sunday], TZ, lateSunday)).toEqual(["- clocks back (Today)"]);
    const monday = new Date("2026-11-02T05:30:00Z"); // 12:30 AM EST Monday
    expect(digestLines([sunday], TZ, monday)[0]).toContain("OVERDUE");
  });
});

describe("fallbackDigest in the user's timezone", () => {
  it("counts an all-day task due today as not yet overdue in the evening", () => {
    const text = fallbackDigest({
      mine: [
        task({ title: "bins", assignedTo: "owner", dueAt: "2026-10-27T04:00:00.000Z", allDay: true }),
      ],
      ours: [],
      partnerName: "Annette",
      tz: "America/New_York",
      now: new Date("2026-10-28T00:30:00Z"), // 8:30 PM EDT
    });
    expect(text).not.toContain("overdue");
  });
});
