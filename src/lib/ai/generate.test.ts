import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@/lib/types";
import type { CompleteArgs, ProviderAdapter, ProviderConfig } from "@/lib/ai/provider";

// A throwaway data directory per run, so the real one is never touched.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "donex-generate-"));
process.env.DATA_DIR = DIR;

const model = vi.hoisted(() => ({
  answer: "{}",
  calls: [] as CompleteArgs[],
}));

vi.mock("@/lib/ai/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/adapters")>();
  const cfg: ProviderConfig = { kind: "openai", baseUrl: "", apiKey: "test", model: "test" };
  const adapter: ProviderAdapter = {
    complete: async (args) => {
      model.calls.push(args);
      return model.answer;
    },
    stream: async () => ({ text: "", toolCalls: [] }),
    models: async () => [],
  };
  return {
    ...actual,
    aiConfigured: () => true,
    callWithFailover: <T>(run: (c: ProviderConfig, a: ProviderAdapter) => Promise<T>) => run(cfg, adapter),
  };
});

const { briefingTasks, eventsOnDate, generateBriefing, generateWeeklyReview, offsetZone, viewpointNames } =
  await import("@/lib/ai/generate");
const { getDb } = await import("@/lib/db");
const { settingsRepo, tasksRepo } = await import("@/lib/db/repos");

const HOME = "America/New_York";

beforeAll(() => {
  settingsRepo.updateApp({ tz: HOME });
});

afterAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

let seq = 0;
function task(over: Partial<Task>): Task {
  seq += 1;
  return {
    id: `t${seq}`,
    title: `Task ${seq}`,
    notes: "",
    status: "open",
    space: "personal",
    createdBy: "owner",
    assignedTo: null,
    priority: 1,
    dueAt: null,
    dueKind: "on",
    allDay: false,
    projectId: null,
    tags: [],
    parentId: null,
    recurrence: null,
    location: null,
    sort: seq,
    completedAt: null,
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
    ...over,
  };
}

describe("offsetZone", () => {
  it("writes minutes east of UTC as a fixed-offset zone", () => {
    expect(offsetZone(540)).toBe("+09:00");
    expect(offsetZone(330)).toBe("+05:30");
    expect(offsetZone(-600)).toBe("-10:00");
    expect(offsetZone(-210)).toBe("-03:30");
    expect(offsetZone(0)).toBe("+00:00");
  });
});

describe("briefingTasks", () => {
  const ids = (list: Task[]) => list.map((t) => t.title).sort();

  it("matches Today at home", () => {
    const now = new Date("2026-10-27T11:00:00Z"); // Tue 07:00 in New York
    const tasks = [
      task({ title: "yesterday", dueAt: "2026-10-26T13:00:00.000Z" }),
      task({ title: "this morning", dueAt: "2026-10-27T13:00:00.000Z" }),
      task({ title: "all day today", dueAt: "2026-10-27T04:00:00.000Z", allDay: true }),
      task({ title: "tomorrow", dueAt: "2026-10-28T13:00:00.000Z" }),
      task({ title: "deadline friday", dueAt: "2026-10-30T04:00:00.000Z", allDay: true, dueKind: "by" }),
      task({ title: "someday" }),
      task({ title: "project, next week", dueAt: "2026-11-03T13:00:00.000Z", dueKind: "by", projectId: "p1" }),
    ];
    const out = briefingTasks(tasks, { dateLocal: "2026-10-27", tz: HOME, homeTz: HOME, now });
    expect(ids(out.overdue)).toEqual(["yesterday"]);
    expect(ids(out.dueToday)).toEqual(["all day today", "deadline friday", "this morning"]);
  });

  it("follows the destination's day on a trip east", () => {
    // Tue 07:00 in Tokyo is still Mon 18:00 in New York.
    const now = new Date("2026-10-26T22:00:00Z");
    const tasks = [
      task({ title: "mon 9am ny", dueAt: "2026-10-26T13:00:00.000Z" }), // Mon 22:00 Tokyo
      task({ title: "tue 10am ny", dueAt: "2026-10-27T14:00:00.000Z" }), // Tue 23:00 Tokyo
      task({ title: "all day mon", dueAt: "2026-10-26T04:00:00.000Z", allDay: true }),
      task({ title: "all day tue", dueAt: "2026-10-27T04:00:00.000Z", allDay: true }),
      task({ title: "wed 10am ny", dueAt: "2026-10-28T14:00:00.000Z" }),
    ];
    const out = briefingTasks(tasks, { dateLocal: "2026-10-27", tz: offsetZone(540), homeTz: HOME, now });
    expect(ids(out.overdue)).toEqual(["all day mon", "mon 9am ny"]);
    expect(ids(out.dueToday)).toEqual(["all day tue", "tue 10am ny"]);
  });

  it("keeps an all-day task on its date on a trip west", () => {
    // Tue 08:00 in Honolulu; the all-day Tuesday task is stored at New York
    // midnight, which is still Monday evening there.
    const now = new Date("2026-10-27T18:00:00Z");
    const tasks = [task({ title: "all day tue", dueAt: "2026-10-27T04:00:00.000Z", allDay: true })];
    const out = briefingTasks(tasks, { dateLocal: "2026-10-27", tz: offsetZone(-600), homeTz: HOME, now });
    expect(out.overdue).toHaveLength(0);
    expect(ids(out.dueToday)).toEqual(["all day tue"]);
  });
});

describe("generateBriefing on a trip", () => {
  beforeEach(() => {
    model.calls = [];
    model.answer = JSON.stringify({ greeting: "Good morning", narrative: "A day.", focusTaskIds: [] });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-26T22:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the destination's date, weekday and time, and its tasks", async () => {
    tasksRepo.create({ title: "Call the hotel", dueAt: "2026-10-27T14:00:00.000Z" });
    await generateBriefing("2026-10-27", { force: true, awayOffsetMinutes: 540 });

    const prompt = model.calls[0].prompt;
    expect(prompt).toContain("DATE: 2026-10-27 (Tuesday), local time 07:00");
    const dueToday = prompt.split("DUE TODAY")[1].split("OVERDUE")[0];
    expect(dueToday).toContain("Call the hotel");
    // Momentum is about the trip's day, which has only just begun.
    const momentum = prompt.split("MOMENTUM")[1];
    expect(momentum).toContain("1 on today's list");
    expect(momentum).not.toContain("done today");
  });
});

describe("eventsOnDate", () => {
  const ev = (id: string, start: string, end: string, allDay: boolean) => ({
    id,
    title: id,
    start,
    end,
    allDay,
    location: null,
  });

  it("keeps all-day events on their own date and every timed event", () => {
    const events = [
      ev("monday", "2026-10-26", "2026-10-27", true),
      ev("tuesday", "2026-10-27", "2026-10-28", true),
      ev("long weekend", "2026-10-25", "2026-10-29", true),
      ev("wednesday", "2026-10-28", "2026-10-29", true),
      ev("no end", "2026-10-27", "2026-10-27", true),
      ev("dinner", "2026-10-27T09:00:00Z", "2026-10-27T11:00:00Z", false),
    ];
    expect(eventsOnDate(events, "2026-10-27").map((e) => e.id)).toEqual([
      "tuesday",
      "long weekend",
      "no end",
      "dinner",
    ]);
  });
});

describe("viewpointNames", () => {
  it("never calls the other person 'You' when names are blank", () => {
    const blank = { ownerName: "", partnerName: "" };
    expect(viewpointNames(blank, "partner").partnerName).toBe("your partner");
    expect(viewpointNames(blank, "owner").partnerName).toBe("your partner");
  });

  it("uses the names that are set, from each side", () => {
    const names = { ownerName: "Sam", partnerName: "Alex" };
    expect(viewpointNames(names, "owner")).toEqual({ personName: "Sam", partnerName: "Alex" });
    expect(viewpointNames(names, "partner")).toEqual({ personName: "Alex", partnerName: "Sam" });
  });
});

describe("generateWeeklyReview", () => {
  it("counts every task created in the week, however long the history", async () => {
    model.answer = JSON.stringify({ bestDay: null, narrative: "A week.", suggestions: [] });
    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO tasks(id,title,notes,status,space,created_by,priority,due_at,due_kind,all_day,tags,sort,created_at,updated_at)
       VALUES(?,?,'',?,'personal','owner',0,?,'on',0,'[]',0,?,?)`,
    );
    const old = "2025-01-06T15:00:00.000Z";
    db.transaction(() => {
      // Plenty of older dated work, which a capped list would read first.
      for (let i = 0; i < 520; i++) insert.run(`old-${i}`, `old ${i}`, i % 2 ? "done" : "open", old, old, old);
      // Created in ISO week 2026-W43 (Mon 19 – Sun 25 October, New York time).
      for (let i = 0; i < 12; i++) {
        insert.run(`new-${i}`, `new ${i}`, "open", null, "2026-10-21T15:00:00.000Z", "2026-10-21T15:00:00.000Z");
      }
      // Sunday 23:30 in New York is already Monday in UTC: still this week.
      insert.run("late", "late sunday", "open", null, "2026-10-26T03:30:00.000Z", "2026-10-26T03:30:00.000Z");
      // Monday 00:30 New York belongs to the next week.
      insert.run("next", "next monday", "open", null, "2026-10-26T04:30:00.000Z", "2026-10-26T04:30:00.000Z");
    })();

    const review = await generateWeeklyReview("2026-W43", { force: true });
    expect(review.createdCount).toBe(13);
  });
});
