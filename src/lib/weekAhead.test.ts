import { describe, expect, it } from "vitest";
import {
  contextLines,
  fallbackWeekAhead,
  normalizeWeekTime,
  shouldSendWeekAhead,
  weekAheadContext,
  weekWindow,
  worthSending,
} from "@/lib/weekAhead";
import type { CalendarEvent, Task } from "@/lib/types";

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: Math.random().toString(36).slice(2),
    title: "something",
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

const ev = (title: string, start: string): CalendarEvent => ({
  id: title,
  title,
  start,
  end: start,
  allDay: false,
  location: null,
});

const TASKS = [
  task({ title: "SAMS-renew the permit", assignedTo: "owner" }),
  task({ title: "ANNETTES-book the dentist", assignedTo: "partner" }),
  task({ title: "ANNETTES-call the plumber", assignedTo: "partner" }),
  task({ title: "EITHER-water the plants", assignedTo: null }),
  task({ title: "done already", assignedTo: "owner", status: "done" }),
];

const EVENTS = [
  ev("Dinner with friends", "2026-09-16T19:00:00-04:00"),
  ev("Yoga class", "2026-09-15T07:00:00-04:00"),
];

describe("weekAheadContext", () => {
  it("gives you your own and the unclaimed, and only a count of theirs", () => {
    const ctx = weekAheadContext({ tasks: TASKS, events: EVENTS, role: "owner" });
    expect(ctx.mine.map((t) => t.title)).toEqual(["SAMS-renew the permit"]);
    expect(ctx.ours.map((t) => t.title)).toEqual(["EITHER-water the plants"]);
    expect(ctx.theirCount).toBe(2);
  });

  it("works the same way from her side", () => {
    const ctx = weekAheadContext({ tasks: TASKS, events: EVENTS, role: "partner" });
    expect(ctx.mine.map((t) => t.title)).toEqual([
      "ANNETTES-book the dentist",
      "ANNETTES-call the plumber",
    ]);
    expect(ctx.theirCount).toBe(1);
  });

  it("ignores finished work", () => {
    const ctx = weekAheadContext({ tasks: TASKS, events: [], role: "owner" });
    expect(ctx.mine.some((t) => t.title === "done already")).toBe(false);
  });

  it("counts what is already late", () => {
    const ctx = weekAheadContext({
      tasks: [task({ assignedTo: "owner", dueAt: "2020-01-01T10:00:00.000Z" })],
      events: [],
      role: "owner",
    });
    expect(ctx.overdueCount).toBe(1);
  });

  it("puts the calendar in time order", () => {
    const ctx = weekAheadContext({ tasks: [], events: EVENTS, role: "owner" });
    expect(ctx.events.map((e) => e.title)).toEqual(["Yoga class", "Dinner with friends"]);
  });
});

describe("contextLines", () => {
  it("never writes the other person's tasks into the prompt", () => {
    const ctx = weekAheadContext({ tasks: TASKS, events: EVENTS, role: "owner" });
    const lines = contextLines(ctx);
    const everything = `${lines.mine}\n${lines.ours}\n${lines.events}`;
    expect(everything).toContain("SAMS-renew the permit");
    expect(everything).not.toContain("ANNETTES-book the dentist");
    expect(everything).not.toContain("ANNETTES-call the plumber");
  });
});

describe("fallbackWeekAhead", () => {
  it("counts both lists, the late ones, and her load", () => {
    const ctx = weekAheadContext({ tasks: TASKS, events: EVENTS, role: "owner" });
    const text = fallbackWeekAhead(ctx, "Annette");
    expect(text).toContain("1 tagged for you");
    expect(text).toContain("1 unclaimed");
    expect(text).toContain("Annette has 2");
    expect(text).toContain("2 things on the calendar");
  });

  it("names her load without naming her tasks", () => {
    const ctx = weekAheadContext({ tasks: TASKS, events: [], role: "owner" });
    const text = fallbackWeekAhead(ctx, "Annette");
    expect(text).not.toContain("dentist");
    expect(text).not.toContain("plumber");
  });

  it("says so when the week is clear", () => {
    const ctx = weekAheadContext({ tasks: [], events: [], role: "owner" });
    expect(fallbackWeekAhead(ctx, "Annette")).toMatch(/clear week/i);
  });
});

describe("worthSending", () => {
  it("is worth it when there is anything at all", () => {
    expect(worthSending(weekAheadContext({ tasks: TASKS, events: [], role: "owner" }))).toBe(true);
    expect(worthSending(weekAheadContext({ tasks: [], events: EVENTS, role: "owner" }))).toBe(true);
  });

  it("is not worth it when the week is empty", () => {
    expect(worthSending(weekAheadContext({ tasks: [], events: [], role: "owner" }))).toBe(false);
  });

  it("is not worth buzzing you about work that is only hers", () => {
    const onlyHers = [task({ assignedTo: "partner" })];
    expect(worthSending(weekAheadContext({ tasks: onlyHers, events: [], role: "owner" }))).toBe(
      false,
    );
  });
});

describe("shouldSendWeekAhead", () => {
  const on = { enabled: true, time: "18:00" };

  it("sends Sunday at your hour", () => {
    expect(
      shouldSendWeekAhead({
        schedule: on,
        nowTime: "18:00",
        weekday: 0,
        weekKey: "2026-W38",
        lastSent: null,
      }),
    ).toBe(true);
  });

  it("stays quiet the rest of the week", () => {
    for (const weekday of [1, 2, 3, 4, 5, 6]) {
      expect(
        shouldSendWeekAhead({
          schedule: on,
          nowTime: "18:00",
          weekday,
          weekKey: "2026-W38",
          lastSent: null,
        }),
      ).toBe(false);
    }
  });

  it("only ever sends once a week", () => {
    expect(
      shouldSendWeekAhead({
        schedule: on,
        nowTime: "18:00",
        weekday: 0,
        weekKey: "2026-W38",
        lastSent: "2026-W38",
      }),
    ).toBe(false);
    expect(
      shouldSendWeekAhead({
        schedule: on,
        nowTime: "18:00",
        weekday: 0,
        weekKey: "2026-W39",
        lastSent: "2026-W38",
      }),
    ).toBe(true);
  });

  it("respects the off switch and the wrong minute", () => {
    const base = { nowTime: "18:00", weekday: 0, weekKey: "2026-W38", lastSent: null };
    expect(shouldSendWeekAhead({ ...base, schedule: { enabled: false, time: "18:00" } })).toBe(false);
    expect(shouldSendWeekAhead({ ...base, nowTime: "17:59", schedule: on })).toBe(false);
  });

  it("reads a sloppily stored time", () => {
    expect(
      shouldSendWeekAhead({
        schedule: { enabled: true, time: "9:05" },
        nowTime: "09:05",
        weekday: 0,
        weekKey: "2026-W38",
        lastSent: null,
      }),
    ).toBe(true);
  });
});

describe("normalizeWeekTime", () => {
  it("pads and defends", () => {
    expect(normalizeWeekTime("7:30")).toBe("07:30");
    expect(normalizeWeekTime("18:00")).toBe("18:00");
    expect(normalizeWeekTime("")).toBe("18:00");
    expect(normalizeWeekTime("25:00")).toBe("18:00");
  });
});

describe("weekWindow", () => {
  it("runs Monday to Monday off the Sunday it is sent", () => {
    expect(weekWindow("2026-09-13")).toEqual({ fromKey: "2026-09-14", toKey: "2026-09-21" });
  });

  it("crosses a month and a year without help", () => {
    expect(weekWindow("2026-08-30")).toEqual({ fromKey: "2026-08-31", toKey: "2026-09-07" });
    expect(weekWindow("2026-12-27")).toEqual({ fromKey: "2026-12-28", toKey: "2027-01-04" });
  });
});
