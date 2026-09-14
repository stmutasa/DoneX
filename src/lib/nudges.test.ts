import { describe, expect, it } from "vitest";
import {
  daysLate,
  latenessLabel,
  nudgeText,
  nudgesFor,
  pastDue,
  waitingLines,
  waitingOn,
} from "@/lib/nudges";
import type { Task } from "@/lib/types";

const NOW = new Date("2026-09-20T18:00:00Z");

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: Math.random().toString(36).slice(2),
    title: "something",
    notes: "",
    status: "open",
    space: "joint",
    createdBy: "owner",
    assignedTo: "partner",
    priority: 0,
    dueAt: "2026-09-18T14:00:00Z",
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

const never = () => null;

describe("pastDue", () => {
  it("is late once the moment has gone", () => {
    expect(pastDue(task({ dueAt: "2026-09-20T17:59:00Z" }), NOW)).toBe(true);
    expect(pastDue(task({ dueAt: "2026-09-20T18:01:00Z" }), NOW)).toBe(false);
  });

  it("gives an all-day task the whole day", () => {
    const today = task({ dueAt: "2026-09-20T00:00:00", allDay: true });
    expect(pastDue(today, NOW)).toBe(false);
    const yesterday = task({ dueAt: "2026-09-19T00:00:00", allDay: true });
    expect(pastDue(yesterday, NOW)).toBe(true);
  });

  it("says no when there is no deadline at all", () => {
    expect(pastDue(task({ dueAt: null }), NOW)).toBe(false);
  });
});

describe("nudgesFor", () => {
  it("raises work the other person asked of you", () => {
    const items = nudgesFor({
      tasks: [task({ title: "renew the permit" })],
      role: "partner",
      now: NOW,
      nudgedDueAt: never,
    });
    expect(items.map((i) => i.title)).toEqual(["renew the permit"]);
    expect(items[0].daysLate).toBe(2);
  });

  it("never nudges the person who did the asking", () => {
    expect(
      nudgesFor({ tasks: [task()], role: "owner", now: NOW, nudgedDueAt: never }),
    ).toEqual([]);
  });

  it("ignores a task you tagged for yourself", () => {
    const own = task({ createdBy: "partner", assignedTo: "partner" });
    expect(
      nudgesFor({ tasks: [own], role: "partner", now: NOW, nudgedDueAt: never }),
    ).toEqual([]);
  });

  it("leaves unclaimed, finished, undated and personal work alone", () => {
    const skipped = [
      task({ assignedTo: null }),
      task({ status: "done" }),
      task({ dueAt: null }),
      task({ space: "personal" }),
      task({ parentId: "parent-1" }),
      task({ dueAt: "2026-09-25T14:00:00Z" }), // not due yet
    ];
    expect(
      nudgesFor({ tasks: skipped, role: "partner", now: NOW, nudgedDueAt: never }),
    ).toEqual([]);
  });

  it("says a thing once per deadline, not once a day", () => {
    const t = task();
    const already = () => t.dueAt;
    expect(nudgesFor({ tasks: [t], role: "partner", now: NOW, nudgedDueAt: already })).toEqual([]);
  });

  it("speaks up again when the deadline is moved and missed again", () => {
    const t = task({ dueAt: "2026-09-19T14:00:00Z" });
    const nudgedForTheOldOne = () => "2026-09-18T14:00:00Z";
    const items = nudgesFor({
      tasks: [t],
      role: "partner",
      now: NOW,
      nudgedDueAt: nudgedForTheOldOne,
    });
    expect(items.length).toBe(1);
  });

  it("lets go of deadlines that stopped meaning anything", () => {
    const ancient = task({ dueAt: "2026-06-01T14:00:00Z" });
    expect(
      nudgesFor({ tasks: [ancient], role: "partner", now: NOW, nudgedDueAt: never }),
    ).toEqual([]);
  });

  it("puts the latest first", () => {
    const items = nudgesFor({
      tasks: [
        task({ title: "recent", dueAt: "2026-09-19T14:00:00Z" }),
        task({ title: "ancient", dueAt: "2026-09-05T14:00:00Z" }),
      ],
      role: "partner",
      now: NOW,
      nudgedDueAt: never,
    });
    expect(items.map((i) => i.title)).toEqual(["ancient", "recent"]);
  });
});

describe("waitingOn", () => {
  it("shows the asker their own overdue asks", () => {
    const items = waitingOn([task({ title: "renew the permit" })], "owner", NOW);
    expect(items.map((i) => i.title)).toEqual(["renew the permit"]);
  });

  it("is not the other side of the same coin", () => {
    expect(waitingOn([task()], "partner", NOW)).toEqual([]);
  });

  it("does not care whether a nudge already went out", () => {
    // The asker keeps seeing it until it is actually done.
    expect(waitingOn([task()], "owner", NOW).length).toBe(1);
  });

  it("drops what is too old to have been nudged, so the two halves agree", () => {
    const ancient = task({ dueAt: "2026-06-01T14:00:00Z" });
    expect(waitingOn([ancient], "owner", NOW)).toEqual([]);
    expect(
      nudgesFor({ tasks: [ancient], role: "partner", now: NOW, nudgedDueAt: never }),
    ).toEqual([]);
  });
});

describe("nudgeText", () => {
  const items = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      nudgesFor({
        tasks: [task({ title: `job ${i + 1}`, dueAt: "2026-09-19T14:00:00Z" })],
        role: "partner",
        now: NOW,
        nudgedDueAt: never,
      })[0],
    );

  it("names the one thing, and who asked", () => {
    const { title, body } = nudgeText(items(1), "Sam");
    expect(title).toBe("Still open: job 1");
    expect(body).toContain("Sam asked you");
    expect(body).toContain("yesterday");
  });

  it("stays gentle rather than scolding", () => {
    expect(nudgeText(items(1), "Sam").body).toMatch(/no rush/i);
  });

  it("batches several into one, naming a couple", () => {
    const { title, body } = nudgeText(items(4), "Sam");
    expect(title).toBe("4 things Sam asked about");
    expect(body).toContain("“job 1”, “job 2” and 2 more");
  });

  it("has nothing to say about nothing", () => {
    expect(nudgeText([], "Sam")).toEqual({ title: "", body: "" });
  });
});

describe("latenessLabel", () => {
  it("reads like a person wrote it", () => {
    expect(latenessLabel(0)).toBe("earlier today");
    expect(latenessLabel(1)).toBe("yesterday");
    expect(latenessLabel(5)).toBe("5 days ago");
  });
});

describe("daysLate", () => {
  it("counts whole days only", () => {
    expect(daysLate("2026-09-20T06:00:00Z", NOW)).toBe(0);
    expect(daysLate("2026-09-19T06:00:00Z", NOW)).toBe(1);
    expect(daysLate("2026-09-25T06:00:00Z", NOW)).toBe(0);
  });
});

describe("waitingLines", () => {
  it("writes the asker's side for the digest", () => {
    const items = waitingOn([task({ title: "renew the permit" })], "owner", NOW);
    expect(waitingLines(items, "Annette")).toBe(
      "- renew the permit — asked of Annette, due 2 days ago",
    );
  });

  it("is empty when nothing is outstanding", () => {
    expect(waitingLines([], "Annette")).toBe("");
  });
});
