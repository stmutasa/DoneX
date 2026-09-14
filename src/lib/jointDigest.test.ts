import { describe, expect, it } from "vitest";
import {
  clockLabel,
  fallbackDigest,
  isValidTime,
  normalizeTime,
  shouldSendDigest,
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

  it("stays quiet at any other minute", () => {
    expect(shouldSendDigest({ ...base, nowTime: "07:01" })).toBe(false);
    expect(shouldSendDigest({ ...base, nowTime: "10:00" })).toBe(false);
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
