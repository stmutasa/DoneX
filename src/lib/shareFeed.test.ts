import { describe, expect, it } from "vitest";
import { buildFeed, dateKeyLabel, localStamp, renderMarkdown } from "@/lib/shareFeed";
import type { Task } from "@/lib/types";

const TZ = "America/New_York";
// 2026-09-17 10:00 in New York
const NOW = new Date("2026-09-17T14:00:00Z");

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: Math.random().toString(36).slice(2),
    title: "something",
    notes: "",
    status: "open",
    space: "personal",
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

const feedOf = (tasks: Task[], joint: Task[] = []) =>
  buildFeed({
    tasks,
    joint,
    projectNames: new Map([["p1", "House"]]),
    tz: TZ,
    now: NOW,
    owner: "Sam",
  });

const titles = (f: ReturnType<typeof feedOf>, bucket: string) =>
  f.groups.find((g) => g.bucket === bucket)?.tasks.map((t) => t.title) ?? [];

describe("buildFeed", () => {
  it("sorts the week into when things are wanted", () => {
    const f = feedOf([
      task({ title: "late", dueAt: "2026-09-14T13:00:00Z" }),
      task({ title: "now", dueAt: "2026-09-17T18:00:00Z" }),
      task({ title: "soon", dueAt: "2026-09-20T13:00:00Z" }),
      task({ title: "far", dueAt: "2026-10-30T13:00:00Z" }),
      task({ title: "whenever" }),
    ]);
    expect(titles(f, "overdue")).toEqual(["late"]);
    expect(titles(f, "today")).toEqual(["now"]);
    expect(titles(f, "week")).toEqual(["soon"]);
    expect(titles(f, "later")).toEqual(["far"]);
    expect(titles(f, "someday")).toEqual(["whenever"]);
  });

  it("reads the day in your timezone, not UTC", () => {
    // 01:00 UTC on the 18th is still the evening of the 17th in New York.
    const f = feedOf([task({ title: "tonight", dueAt: "2026-09-18T01:00:00Z" })]);
    expect(titles(f, "today")).toEqual(["tonight"]);
  });

  it("leaves finished work and subtasks out", () => {
    const f = feedOf([
      task({ title: "done", status: "done" }),
      task({ title: "subtask", parentId: "p" }),
      task({ title: "real" }),
    ]);
    expect(f.counts.open).toBe(1);
    expect(titles(f, "someday")).toEqual(["real"]);
  });

  it("carries the shared work that is actually yours", () => {
    const f = feedOf(
      [],
      [
        task({ title: "mine", space: "joint", assignedTo: "owner" }),
        task({ title: "either of ours", space: "joint", assignedTo: null }),
        task({ title: "HERS", space: "joint", assignedTo: "partner" }),
      ],
    );
    expect(titles(f, "someday")).toEqual(["either of ours", "mine"]);
  });

  it("never publishes what the other person has taken on", () => {
    const f = feedOf([], [task({ title: "HER PRIVATE ERRAND", space: "joint", assignedTo: "partner" })]);
    expect(JSON.stringify(f)).not.toContain("HER PRIVATE ERRAND");
    expect(renderMarkdown(f)).not.toContain("HER PRIVATE ERRAND");
  });

  it("reads the same way round from her side", () => {
    const joint = [
      task({ title: "hers", space: "joint", assignedTo: "partner" }),
      task({ title: "HIS", space: "joint", assignedTo: "owner" }),
    ];
    const f = buildFeed({
      tasks: [],
      joint,
      projectNames: new Map(),
      tz: TZ,
      now: NOW,
      owner: "Annette",
      role: "partner",
    });
    expect(titles(f, "someday")).toEqual(["hers"]);
    expect(renderMarkdown(f)).not.toContain("HIS");
  });

  it("marks where a shared task came from", () => {
    const f = feedOf(
      [],
      [
        task({ title: "mine", space: "joint", assignedTo: "owner" }),
        task({ title: "ours", space: "joint", assignedTo: null }),
      ],
    );
    const shared = f.groups[0].tasks;
    expect(shared.find((t) => t.title === "mine")?.shared).toBe("you");
    expect(shared.find((t) => t.title === "ours")?.shared).toBe("either");
  });

  it("names the project and keeps the tags", () => {
    const f = feedOf([task({ title: "paint", projectId: "p1", tags: ["home", "weekend"] })]);
    const t = f.groups[0].tasks[0];
    expect(t.project).toBe("House");
    expect(t.tags).toEqual(["home", "weekend"]);
  });

  it("counts what matters at the top", () => {
    const f = feedOf([
      task({ dueAt: "2026-09-14T13:00:00Z" }),
      task({ dueAt: "2026-09-15T13:00:00Z" }),
      task({ dueAt: "2026-09-17T18:00:00Z" }),
      task({}),
    ]);
    expect(f.counts).toEqual({ open: 4, overdue: 2, today: 1 });
  });

  it("puts the soonest and most urgent first", () => {
    const f = feedOf([
      task({ title: "later that day", dueAt: "2026-09-17T22:00:00Z" }),
      task({ title: "first thing", dueAt: "2026-09-17T12:00:00Z" }),
    ]);
    expect(titles(f, "today")).toEqual(["first thing", "later that day"]);
  });

  it("drops empty buckets rather than printing headings for nothing", () => {
    const f = feedOf([task({ title: "only one" })]);
    expect(f.groups.map((g) => g.bucket)).toEqual(["someday"]);
  });

  it("shortens a wall of notes", () => {
    const f = feedOf([task({ notes: "x".repeat(900) })]);
    const notes = f.groups[0].tasks[0].notes;
    expect(notes.length).toBeLessThan(420);
    expect(notes.endsWith("…")).toBe(true);
  });
});

describe("renderMarkdown", () => {
  it("writes something a chat window can read", () => {
    const f = feedOf([
      task({ title: "renew the permit", dueAt: "2026-09-14T13:00:00Z", priority: 3, projectId: "p1" }),
      task({ title: "water the plants", notes: "the big one by the window" }),
    ]);
    const md = renderMarkdown(f);
    expect(md).toContain("# Sam's open tasks");
    expect(md).toContain("## Overdue (1)");
    expect(md).toContain("**renew the permit** — Mon 14 Sep · High · House");
    expect(md).toContain("## No date (1)");
    expect(md).toContain("  > the big one by the window");
  });

  it("stamps the moment on your own clock, not UTC", () => {
    // NOW is 14:00 UTC, which is 10:00 AM in New York.
    const md = renderMarkdown(feedOf([task({})]));
    expect(md).toContain("**Live as of Thu 17 Sep, 10:00 AM EDT.**");
    expect(md).not.toContain("UTC");
    expect(md).toContain("America/New_York");
  });

  it("tells a reader holding an old copy to fetch it again", () => {
    const md = renderMarkdown(feedOf([task({})]));
    expect(md).toContain("rebuilt from DoneX every time this link is opened");
    expect(md).toContain("open the link again before answering");
  });

  it("puts the same freshness facts in the JSON", () => {
    const f = feedOf([task({})]);
    expect(f.generatedAtLocal).toBe("Thu 17 Sep, 10:00 AM EDT");
    expect(f.freshness).toMatch(/open the link again/);
  });

  it("says so when there is nothing left", () => {
    expect(renderMarkdown(feedOf([]))).toContain("Nothing open");
  });

  it("calls today today", () => {
    const md = renderMarkdown(feedOf([task({ title: "now", dueAt: "2026-09-17T18:00:00Z" })]));
    expect(md).toContain("**now** — Today");
  });
});

describe("dateKeyLabel", () => {
  it("reads like a date", () => {
    expect(dateKeyLabel("2026-09-14")).toBe("Mon 14 Sep");
    expect(dateKeyLabel("2027-01-01")).toBe("Fri 1 Jan");
  });
});

describe("localStamp", () => {
  it("follows daylight saving", () => {
    expect(localStamp(new Date("2026-10-09T09:02:00Z"), "America/New_York")).toBe("Fri 9 Oct, 5:02 AM EDT");
    expect(localStamp(new Date("2026-12-09T10:02:00Z"), "America/New_York")).toBe("Wed 9 Dec, 5:02 AM EST");
  });

  it("works anywhere you happen to be", () => {
    expect(localStamp(new Date("2026-10-09T09:02:00Z"), "America/Chicago")).toBe("Fri 9 Oct, 4:02 AM CDT");
  });
});
