import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The server runs in UTC; pin it so zone mix-ups show on any machine.
process.env.TZ = "UTC";

// A throwaway data directory per run, so the real one is never touched.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "donex-tools-"));
process.env.DATA_DIR = DIR;

const { findTool, readDueInput, toolContext } = await import("@/lib/ai/tools");
const { getDb } = await import("@/lib/db");
const { notesRepo, projectsRepo, settingsRepo, tasksRepo } = await import("@/lib/db/repos");
const { isoFromLocal } = await import("@/lib/utils");

const TZ = "America/New_York";

/** Runs a tool; each call is its own chat turn unless a turn's ctx is passed. */
async function run(name: string, args: Record<string, unknown>, ctx = toolContext(TZ)) {
  const spec = findTool(name);
  if (!spec) throw new Error(`no tool ${name}`);
  return spec.run(args, ctx);
}

function completions(taskId: string): number {
  const row = getDb().prepare("SELECT COUNT(*) c FROM completions WHERE task_id=?").get(taskId) as {
    c: number;
  };
  return row.c;
}

beforeAll(() => {
  settingsRepo.updateApp({ tz: TZ });
});

afterAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("readDueInput", () => {
  it("keeps junk apart from an explicit clear", () => {
    expect(readDueInput("next Friday", TZ)).toBe("invalid");
    expect(readDueInput("someday", TZ)).toBe("invalid");
    expect(readDueInput(1785000000000, TZ)).toBe("invalid");
    expect(readDueInput(null, TZ)).toEqual({ dueAt: null, allDay: false });
    expect(readDueInput("", TZ)).toEqual({ dueAt: null, allDay: false });
    expect(readDueInput("none", TZ)).toEqual({ dueAt: null, allDay: false });
    expect(readDueInput(undefined, TZ)).toBeUndefined();
  });

  it("reads a one-digit hour as local time", () => {
    expect(readDueInput("2026-10-30T9:00", TZ)).toEqual({ dueAt: "2026-10-30T13:00:00.000Z", allDay: false });
  });

  it("reads 12-hour times in the user's zone, not the server's", () => {
    expect(readDueInput("2026-08-09 3:00 PM", TZ)).toEqual({ dueAt: "2026-08-09T19:00:00.000Z", allDay: false });
    expect(readDueInput("2026-08-09 12:15 am", TZ)).toEqual({ dueAt: "2026-08-09T04:15:00.000Z", allDay: false });
  });

  it("accepts the user's own zone name but no other", () => {
    expect(readDueInput("2026-08-09T15:00 America/New_York", TZ)).toEqual({
      dueAt: "2026-08-09T19:00:00.000Z",
      allDay: false,
    });
    expect(readDueInput("2026-08-09T15:00 America/Chicago", TZ)).toBe("invalid");
    expect(readDueInput("2026-08-09T15:00 EST", TZ)).toBe("invalid");
    expect(readDueInput("2026-08-09T15:00 next week", TZ)).toBe("invalid");
  });

  it("reads zone designators, including UTC, GMT and hour-only offsets", () => {
    const at = (dueAt: string) => ({ dueAt, allDay: false });
    expect(readDueInput("2026-08-09T15:00:00-04:00", TZ)).toEqual(at("2026-08-09T19:00:00.000Z"));
    expect(readDueInput("2026-08-09T19:00:00.000Z", TZ)).toEqual(at("2026-08-09T19:00:00.000Z"));
    expect(readDueInput("2026-08-09T15:00:00 UTC", TZ)).toEqual(at("2026-08-09T15:00:00.000Z"));
    expect(readDueInput("2026-08-09T15:00 GMT", TZ)).toEqual(at("2026-08-09T15:00:00.000Z"));
    expect(readDueInput("2026-08-09T15:00+05", TZ)).toEqual(at("2026-08-09T10:00:00.000Z"));
    expect(readDueInput("2026-08-09T15:00+0530", TZ)).toEqual(at("2026-08-09T09:30:00.000Z"));
    expect(readDueInput("2026-08-09 3:00 PM UTC", TZ)).toEqual(at("2026-08-09T15:00:00.000Z"));
  });

  it("rejects impossible dates and times", () => {
    expect(readDueInput("2026-08-09T25:00", TZ)).toBe("invalid");
    expect(readDueInput("2026-08-09 13:00 pm", TZ)).toBe("invalid");
    expect(readDueInput("2026-02-30", TZ)).toBe("invalid");
    expect(readDueInput("2026-02-30T09:00", TZ)).toBe("invalid");
    expect(readDueInput("2028-02-29", TZ)).toEqual({ dueAt: "2028-02-29T05:00:00.000Z", allDay: true });
  });
});

describe("readDueInput zone abbreviations", () => {
  it("accepts the user's own abbreviation at that time and no other", () => {
    expect(readDueInput("2026-08-09T15:00:00 EDT", TZ)).toEqual({ dueAt: "2026-08-09T19:00:00.000Z", allDay: false });
    expect(readDueInput("2026-12-09 3:00 PM est", TZ)).toEqual({ dueAt: "2026-12-09T20:00:00.000Z", allDay: false });
    // EST in August is the wrong half of the year for New York.
    expect(readDueInput("2026-08-09T15:00 EST", TZ)).toBe("invalid");
    expect(readDueInput("2026-08-09T15:00 PDT", TZ)).toBe("invalid");
    expect(readDueInput("2026-08-09T15:00Z EDT", TZ)).toBe("invalid");
  });
});

describe("all-day dates sent with a time", () => {
  it("keeps a midnight-Z all-day task on its own date", async () => {
    const out = await run("create_task", { title: "pay taxes", dueAt: "2026-11-15T00:00:00Z", allDay: true });
    const id = (out.payload as { created: { id: string } }).created.id;
    expect(tasksRepo.get(id)?.dueAt).toBe(new Date(isoFromLocal("2026-11-15", "00:00", TZ)).toISOString());
    expect(out.label).toBe("Added “pay taxes” · Sun Nov 15");
  });

  it("moves any other all-day time to local midnight of its day", async () => {
    const task = tasksRepo.create({ title: "renew passport" });
    await run("update_task", { id: task.id, dueAt: "2026-11-20T21:30", allDay: true });
    const after = tasksRepo.get(task.id)!;
    expect(after.allDay).toBe(true);
    expect(after.dueAt).toBe(new Date(isoFromLocal("2026-11-20", "00:00", TZ)).toISOString());
  });
});

describe("update_task keeps a monthly repeat day", () => {
  /** A monthly-on-the-31st task ticked once, so it sits clamped on Nov 30. */
  function clampedTask(title: string) {
    const task = tasksRepo.create({
      title,
      dueAt: new Date(isoFromLocal("2026-11-30", "09:00", TZ)).toISOString(),
      recurrence: { freq: "monthly", byMonthDay: 31 },
    });
    return task.id;
  }

  it("on a time-only change on a clamped day", async () => {
    const id = clampedTask("card reminder");
    await run("update_task", { id, dueAt: "2026-11-30T10:00" });
    expect(tasksRepo.get(id)?.recurrence).toEqual({ freq: "monthly", byMonthDay: 31 });
  });

  it("when an unrelated edit echoes the stored dueAt", async () => {
    const id = clampedTask("water bill");
    await run("update_task", { id, priority: 3, dueAt: tasksRepo.get(id)!.dueAt });
    expect(tasksRepo.get(id)?.recurrence).toEqual({ freq: "monthly", byMonthDay: 31 });
  });

  it("when the rule is resent without a day", async () => {
    const id = clampedTask("phone bill");
    await run("update_task", { id, recurrence: { freq: "monthly", interval: 2 } });
    expect(tasksRepo.get(id)?.recurrence).toEqual({ freq: "monthly", interval: 2, byMonthDay: 31 });
  });

  it("on a one-off push to another day", async () => {
    const id = clampedTask("gas bill");
    await run("update_task", { id, dueAt: "2026-11-27T09:00" });
    expect(tasksRepo.get(id)?.recurrence).toEqual({ freq: "monthly", byMonthDay: 31 });
  });

  it("but takes the day sent in recurrence.byMonthDay", async () => {
    const id = clampedTask("council tax");
    await run("update_task", { id, dueAt: "2026-11-27T09:00", recurrence: { freq: "monthly", byMonthDay: 27 } });
    expect(tasksRepo.get(id)?.recurrence).toEqual({ freq: "monthly", byMonthDay: 27 });
  });

  it("and pins a rule that has no day yet from the new date", async () => {
    const task = tasksRepo.create({
      title: "pet insurance",
      dueAt: new Date(isoFromLocal("2026-11-12", "09:00", TZ)).toISOString(),
      recurrence: { freq: "monthly" },
    });
    await run("update_task", { id: task.id, dueAt: "2026-11-14T09:00" });
    expect(tasksRepo.get(task.id)?.recurrence).toEqual({ freq: "monthly", byMonthDay: 14 });
  });

  it("and a Feb 29 yearly rule keeps its day on a time change", async () => {
    const task = tasksRepo.create({
      title: "leap birthday",
      dueAt: new Date(isoFromLocal("2027-02-28", "09:00", TZ)).toISOString(),
      recurrence: { freq: "yearly", byMonthDay: 29 },
    });
    await run("update_task", { id: task.id, dueAt: "2027-02-28T10:00" });
    expect(tasksRepo.get(task.id)?.recurrence).toEqual({ freq: "yearly", byMonthDay: 29 });
  });
});

describe("projects", () => {
  it("says when create_project restores an archived project", async () => {
    const project = projectsRepo.create({ name: "Allotment" });
    projectsRepo.update(project.id, { archived: true });
    const out = await run("create_project", { name: "allotment" });
    expect(out.label).toBe("Restored archived project “Allotment”");
    expect((out.payload as { restored?: boolean }).restored).toBe(true);
    expect(projectsRepo.get(project.id)?.archived).toBe(false);
  });

  it("notes when filing a task restores an archived project", async () => {
    const project = projectsRepo.create({ name: "Attic" });
    projectsRepo.update(project.id, { archived: true });
    const out = await run("create_task", { title: "sort boxes", projectName: "Attic" });
    expect((out.payload as { projectNote?: string }).projectNote).toBe("Restored archived project “Attic”");
    expect(projectsRepo.get(project.id)?.archived).toBe(false);
  });
});

describe("create_task and update_task", () => {
  it("leaves the due date alone when update_task gets a date it cannot read", async () => {
    const task = tasksRepo.create({ title: "tax form", dueAt: "2026-10-30T13:00:00.000Z" });
    const out = await run("update_task", { id: task.id, dueAt: "next Friday" });
    expect(out.ok).toBe(false);
    expect(tasksRepo.get(task.id)?.dueAt).toBe("2026-10-30T13:00:00.000Z");
  });

  it("still clears the due date on an explicit null", async () => {
    const task = tasksRepo.create({ title: "maybe later", dueAt: "2026-10-30T13:00:00.000Z" });
    const out = await run("update_task", { id: task.id, dueAt: null });
    expect(out.ok).not.toBe(false);
    expect(tasksRepo.get(task.id)?.dueAt).toBeNull();
  });

  it("refuses to create a task from a date it cannot read", async () => {
    const out = await run("create_task", { title: "dentist", dueAt: "next Friday" });
    expect(out.ok).toBe(false);
    expect(tasksRepo.list({ q: "dentist", includeDone: true })).toHaveLength(0);
  });

  it("pins the anchor day of a monthly rule it creates", async () => {
    const out = await run("create_task", {
      title: "pay card",
      dueAt: "2026-01-31",
      recurrence: { freq: "monthly" },
    });
    const id = (out.payload as { created: { id: string } }).created.id;
    expect(tasksRepo.get(id)?.recurrence).toEqual({ freq: "monthly", byMonthDay: 31 });
  });

  it("pins the anchor day when update_task adds a repeat", async () => {
    const task = tasksRepo.create({ title: "rent", dueAt: isoFromLocal("2026-03-31", "09:00", TZ) });
    const out = await run("update_task", { id: task.id, recurrence: { freq: "monthly", interval: 3 } });
    expect(tasksRepo.get(task.id)?.recurrence).toEqual({ freq: "monthly", interval: 3, byMonthDay: 31 });
    expect((out.payload as { updated: { repeat: string } }).updated.repeat).toBe("Quarterly on day 31");
  });

  it("moves only this occurrence when dueAt changes, and the repeat day when one is sent", async () => {
    const out = await run("create_task", {
      title: "water bill",
      dueAt: "2026-01-31T09:00",
      recurrence: { freq: "monthly" },
    });
    const id = (out.payload as { created: { id: string } }).created.id;
    await run("update_task", { id, dueAt: "2026-02-05T09:00" });
    expect(tasksRepo.get(id)?.recurrence).toEqual({ freq: "monthly", byMonthDay: 31 });
    await run("update_task", { id, recurrence: { freq: "monthly", byMonthDay: 5 } });
    expect(tasksRepo.get(id)?.recurrence).toEqual({ freq: "monthly", byMonthDay: 5 });
  });

  it("keeps a subtask and its assignee on the parent's list", async () => {
    const parent = tasksRepo.create({ title: "host dinner", space: "joint" });
    const sub = tasksRepo.create({ title: "buy wine", parentId: parent.id, space: "joint", assignedTo: "partner" });
    const out = await run("update_task", { id: sub.id, space: "personal", title: "buy red wine" });
    expect(out.ok).toBe(false);
    const after = tasksRepo.get(sub.id)!;
    expect(after.space).toBe("joint");
    expect(after.assignedTo).toBe("partner");
    expect(after.title).toBe("buy wine");
  });

  it("moves a shared task and its subtasks to the personal list", async () => {
    const task = tasksRepo.create({ title: "plan surprise birthday", space: "joint", assignedTo: "partner" });
    const sub = tasksRepo.create({ title: "book venue", parentId: task.id, assignedTo: "partner" });
    const out = await run("update_task", { id: task.id, space: "personal" });
    expect(out.ok).not.toBe(false);
    expect(out.label).toBe("Updated “plan surprise birthday”");
    const after = tasksRepo.get(task.id)!;
    expect(after.space).toBe("personal");
    expect(after.assignedTo).toBeNull();
    expect(tasksRepo.get(sub.id)?.space).toBe("personal");
  });

  it("keeps shared tasks out of projects without creating one", async () => {
    const task = tasksRepo.create({ title: "fix the gate" });
    const out = await run("update_task", { id: task.id, space: "joint", projectName: "Garden" });
    expect(tasksRepo.get(task.id)?.projectId).toBeNull();
    expect((out.payload as { projectNote?: string }).projectNote).toBe(
      "Shared tasks can't be in a project, so the project was left off."
    );
    await run("create_task", { title: "paint the shed", space: "joint", projectName: "Garden" });
    expect(projectsRepo.findByName("Garden")).toBeNull();
  });

  it("says so when nothing changes", async () => {
    const task = tasksRepo.create({ title: "water plants" });
    const out = await run("update_task", { id: task.id, space: "personal" });
    expect(out.ok).not.toBe(false);
    expect(out.label).toBe("No changes to “water plants”");
  });
});

describe("complete_task", () => {
  it("does not log a second completion for a task that is already done", async () => {
    const task = tasksRepo.create({ title: "call mum" });
    await run("complete_task", { id: task.id });
    const again = await run("complete_task", { id: task.id });
    expect(again.label).toBe("“call mum” was already done");
    expect(completions(task.id)).toBe(1);
  });

  it("reopens a done task", async () => {
    const task = tasksRepo.create({ title: "post letter" });
    await run("complete_task", { id: task.id });
    const out = await run("complete_task", { id: task.id, done: false });
    expect(out.label).toBe("Reopened “post letter”");
    expect(tasksRepo.get(task.id)?.status).toBe("open");
    expect(completions(task.id)).toBe(0);
  });

  it("treats reopening an open task as a no-op", async () => {
    const task = tasksRepo.create({ title: "buy stamps" });
    const out = await run("complete_task", { id: task.id, done: false });
    expect(out.label).toBe("“buy stamps” is already open");
  });

  it("undoes a repeating task's last tick and keeps its next date", async () => {
    const task = tasksRepo.create({
      title: "gym",
      dueAt: new Date(Date.now() + 3600_000).toISOString(),
      recurrence: { freq: "daily", interval: 2 },
    });
    await run("complete_task", { id: task.id });
    const advanced = tasksRepo.get(task.id)!.dueAt!;
    expect(new Date(advanced).getTime()).toBeGreaterThan(Date.now() + 24 * 3600_000);
    expect(completions(task.id)).toBe(1);

    const out = await run("complete_task", { id: task.id, done: false });
    expect(out.ok).not.toBe(false);
    expect(out.label).toMatch(/^Removed the last completion of “gym” · next /);
    expect(completions(task.id)).toBe(0);
    expect(tasksRepo.get(task.id)?.dueAt).toBe(advanced);
    expect(tasksRepo.get(task.id)?.status).toBe("open");

    const again = await run("complete_task", { id: task.id, done: false });
    expect(again.ok).toBe(false);
    expect(tasksRepo.get(task.id)?.dueAt).toBe(advanced);
  });
});

describe("complete_task on a repeating task", () => {
  function gym(title: string) {
    return tasksRepo.create({
      title,
      dueAt: new Date(Date.now() + 3600_000).toISOString(),
      recurrence: { freq: "daily" },
    });
  }

  it("ticks it once when the model completes it twice in one turn", async () => {
    const task = gym("swim");
    const turn = toolContext(TZ);
    await run("complete_task", { id: task.id }, turn);
    const advanced = tasksRepo.get(task.id)!.dueAt;
    const again = await run("complete_task", { id: task.id }, turn);
    expect(again.label).toMatch(/^“swim” was already ticked · next /);
    expect(completions(task.id)).toBe(1);
    expect(tasksRepo.get(task.id)?.dueAt).toBe(advanced);
  });

  it("does not tick it again when expectedDueAt is out of date", async () => {
    const task = gym("run");
    await run("complete_task", { id: task.id, expectedDueAt: task.dueAt });
    const advanced = tasksRepo.get(task.id)!.dueAt;
    const stale = await run("complete_task", { id: task.id, expectedDueAt: task.dueAt });
    expect(stale.label).toMatch(/^“run” was already ticked · next /);
    expect(completions(task.id)).toBe(1);
    const fresh = await run("complete_task", { id: task.id, expectedDueAt: advanced });
    expect(fresh.label).toMatch(/^Completed “run” · next /);
    expect(completions(task.id)).toBe(2);
  });
});

describe("list_tasks", () => {
  it("strips a leading # from the tag filter", async () => {
    tasksRepo.create({ title: "pick up dry cleaning", tags: ["errands"] });
    const out = await run("list_tasks", { view: "all", tag: "#errands" });
    expect((out.payload as { count: number }).count).toBe(1);
  });
});

describe("append_checklist", () => {
  it("adds lines to a plain note instead of hiding its text", async () => {
    notesRepo.create({ title: "Groceries", kind: "note", content: "milk, eggs, bread" });
    await run("append_checklist", { noteTitle: "groceries", items: ["bananas"] });
    const note = notesRepo.findByTitle("Groceries")!;
    expect(note.kind).toBe("note");
    expect(note.content).toBe("milk, eggs, bread\nbananas");
  });

  it("follows the bullet style of a plain list", async () => {
    notesRepo.create({ title: "Packing", kind: "note", content: "- socks\n- charger\n" });
    await run("append_checklist", { noteTitle: "Packing", items: ["passport", "book"] });
    expect(notesRepo.findByTitle("Packing")?.content).toBe("- socks\n- charger\n- passport\n- book");
  });

  it("adds items to an existing checklist", async () => {
    notesRepo.create({
      title: "Hardware",
      kind: "checklist",
      items: [{ id: "a", text: "screws", done: false }],
    });
    await run("append_checklist", { noteTitle: "Hardware", items: ["hinges"] });
    const note = notesRepo.findByTitle("Hardware")!;
    expect(note.kind).toBe("checklist");
    expect(note.items.map((i) => i.text)).toEqual(["screws", "hinges"]);
  });
});
