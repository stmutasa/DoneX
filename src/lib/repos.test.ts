import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Routes read the session through auth; a test picks the role it acts as.
const session = vi.hoisted(() => ({ role: "owner" as "owner" | "partner" }));
vi.mock("@/lib/auth", () => ({
  requireSession: async () => null,
  requireOwner: async () => null,
  sessionRole: async () => session.role,
}));
vi.mock("@/lib/assignNotify", () => ({ alertAssignee: async () => {} }));

// A throwaway data directory per run, so the real one is never touched.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "donex-repos-"));
process.env.DATA_DIR = DIR;

// An older build's database: completions without completed_by, and a joint
// task whose subtask was filed as personal. Opening it must migrate both.
{
  const old = new Database(path.join(DIR, "donex.db"));
  old.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open', priority INTEGER DEFAULT 0, due_at TEXT,
      due_kind TEXT NOT NULL DEFAULT 'on', space TEXT NOT NULL DEFAULT 'personal',
      created_by TEXT NOT NULL DEFAULT 'owner', assigned_to TEXT, nudged_due_at TEXT,
      all_day INTEGER DEFAULT 0, project_id TEXT, tags TEXT DEFAULT '[]', parent_id TEXT,
      recurrence TEXT, location TEXT, sort REAL DEFAULT 0, notified_at TEXT,
      completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE completions (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, title TEXT DEFAULT '',
      completed_at TEXT NOT NULL, date_local TEXT NOT NULL
    );
    INSERT INTO tasks(id,title,space,created_at,updated_at) VALUES('old-parent','Plan trip','joint','2026-01-01','2026-01-01');
    INSERT INTO tasks(id,title,space,parent_id,created_at,updated_at) VALUES('old-child','Book flights','personal','old-parent','2026-01-01','2026-01-01');
    INSERT INTO completions VALUES('old-c','gone','Old tick','2020-01-01T12:00:00.000Z','2020-01-01');
  `);
  old.close();
}

const { getDb } = await import("@/lib/db");
const repos = await import("@/lib/db/repos");
const { tasksRepo, completionsRepo, statsRepo, notesRepo, settingsRepo, importAll, exportAll, ImportError } =
  repos;
const { localDateKey, localTimeKey, isoFromLocal, addDaysToDateKey } = await import("@/lib/utils");
const { NextRequest } = await import("next/server");

const TZ = "America/New_York";
settingsRepo.updateApp({ tz: TZ });

const db = getDb();
const today = () => localDateKey(new Date(), TZ);

beforeEach(() => {
  session.role = "owner";
});

afterAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

function req(url: string, init?: { method?: string; body?: unknown }) {
  return new NextRequest(`http://localhost${url}`, {
    method: init?.method ?? "GET",
    body: init?.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe("migrations", () => {
  it("adds completed_by, counting older ticks as the owner's", () => {
    const row = db.prepare("SELECT completed_by FROM completions WHERE id='old-c'").get() as {
      completed_by: string;
    };
    expect(row.completed_by).toBe("owner");
  });

  it("moves a joint task's subtasks onto the joint list", () => {
    expect(tasksRepo.get("old-child")?.space).toBe("joint");
  });
});

describe("setDone", () => {
  it("is a no-op when the task is already in the asked-for state", () => {
    const t = tasksRepo.create({ title: "one-off" });
    expect(tasksRepo.setDone(t.id, false).changed).toBe(false);

    const first = tasksRepo.setDone(t.id, true);
    expect(first.changed).toBe(true);
    const second = tasksRepo.setDone(t.id, true);
    expect(second.changed).toBe(false);
    expect(second.task?.completedAt).toBe(first.task?.completedAt);
    const count = () =>
      (db.prepare("SELECT COUNT(*) c FROM completions WHERE task_id=?").get(t.id) as { c: number }).c;
    expect(count()).toBe(1);

    expect(tasksRepo.setDone(t.id, false).task?.status).toBe("open");
    expect(count()).toBe(0);
  });

  it("never deletes a repeat's history when asked to reopen it", () => {
    const due = new Date(Date.now() + 3_600_000).toISOString();
    const t = tasksRepo.create({ title: "bins", dueAt: due, recurrence: { freq: "weekly" } });
    tasksRepo.setDone(t.id, true);
    const res = tasksRepo.setDone(t.id, false);
    expect(res.changed).toBe(false);
    expect(
      (db.prepare("SELECT COUNT(*) c FROM completions WHERE task_id=?").get(t.id) as { c: number }).c
    ).toBe(1);
  });

  it("moves an overdue repeat to the first occurrence after now, keeping its time", () => {
    const threeDaysAgo = isoFromLocal(addDaysToDateKey(today(), -3), "08:00", TZ);
    const t = tasksRepo.create({ title: "meds", dueAt: threeDaysAgo, recurrence: { freq: "daily" } });
    const { task, recurred } = tasksRepo.setDone(t.id, true);
    expect(recurred).toBe(true);
    expect(task?.status).toBe("open");
    const next = Date.parse(task!.dueAt!);
    expect(next).toBeGreaterThan(Date.now());
    expect(next - Date.now()).toBeLessThanOrEqual(25 * 3_600_000);
    expect(new Date(task!.dueAt!).toLocaleTimeString("en-US", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false })).toBe("08:00");
  });

  it("skips nothing when a second device ticks a repeat it saw at the old date", () => {
    const due = new Date(Date.now() + 3_600_000).toISOString();
    const t = tasksRepo.create({ title: "trash", dueAt: due, recurrence: { freq: "weekly" } });
    const a = tasksRepo.setDone(t.id, true, { expectedDueAt: due });
    const b = tasksRepo.setDone(t.id, true, { expectedDueAt: due });
    expect(a.changed).toBe(true);
    expect(b.changed).toBe(false);
    expect(b.task?.dueAt).toBe(a.task?.dueAt);
    // One week on by the calendar (the wall-clock time holds across DST).
    expect(localDateKey(a.task!.dueAt!, TZ)).toBe(addDaysToDateKey(localDateKey(due, TZ), 7));
  });

  it("keeps a dateless repeat going, anchored on today as an all-day task", () => {
    const t = tasksRepo.create({ title: "water plants", recurrence: { freq: "weekly", byWeekday: [1] } });
    const { task, recurred } = tasksRepo.setDone(t.id, true);
    expect(recurred).toBe(true);
    expect(task?.status).toBe("open");
    expect(task?.allDay).toBe(true);
    const key = localDateKey(task!.dueAt!, TZ);
    expect(key > today()).toBe(true);
    expect(key <= addDaysToDateKey(today(), 7)).toBe(true);
    expect(new Date(`${key}T12:00:00Z`).getUTCDay()).toBe(1);
    expect(task!.dueAt).toBe(isoFromLocal(key, "00:00", TZ));
  });

  it("keeps a monthly repeat on its day after a short month", () => {
    const jan31 = isoFromLocal("2027-01-31", "09:00", TZ);
    const t = tasksRepo.create({ title: "rent", dueAt: jan31, recurrence: { freq: "monthly" } });
    const feb = tasksRepo.setDone(t.id, true).task!;
    expect(localDateKey(feb.dueAt!, TZ)).toBe("2027-02-28");
    expect(feb.recurrence?.byMonthDay).toBe(31);
    const mar = tasksRepo.setDone(t.id, true).task!;
    expect(localDateKey(mar.dueAt!, TZ)).toBe("2027-03-31");
  });
});

describe("who completed it", () => {
  it("leaves the partner's joint ticks out of the owner's figures", () => {
    const before = statsRepo.summary().today.done;
    const beforeRange = completionsRepo.countRange(today(), today());
    const beforeList = completionsRepo.listRange(today(), today()).length;

    const joint = tasksRepo.create({ title: "milk", space: "joint" }, "partner");
    tasksRepo.setDone(joint.id, true, { by: "partner" });
    expect(statsRepo.summary().today.done).toBe(before);
    expect(completionsRepo.countRange(today(), today())).toBe(beforeRange);
    expect(completionsRepo.listRange(today(), today()).length).toBe(beforeList);

    const mine = tasksRepo.create({ title: "file taxes" });
    tasksRepo.setDone(mine.id, true);
    expect(statsRepo.summary().today.done).toBe(before + 1);
    expect(completionsRepo.countsByDay(today(), today()).get(today())).toBe(beforeRange + 1);
  });
});

describe("subtasks and lists", () => {
  it("files a subtask on its parent's list", () => {
    const parent = tasksRepo.create({ title: "Groceries", space: "joint" });
    const child = tasksRepo.create({ title: "eggs", parentId: parent.id });
    expect(child.space).toBe("joint");

    const loose = tasksRepo.create({ title: "loose" });
    expect(tasksRepo.update(loose.id, { parentId: parent.id })?.space).toBe("joint");
  });

  it("moves a task between lists, with its subtasks", () => {
    const t = tasksRepo.create({ title: "Buy paint", projectId: "p1" });
    const sub = tasksRepo.create({ title: "white", parentId: t.id });
    const moved = tasksRepo.update(t.id, { space: "joint", assignedTo: "partner" })!;
    expect(moved.space).toBe("joint");
    expect(moved.projectId).toBeNull();
    expect(moved.assignedTo).toBe("partner");
    expect(tasksRepo.get(sub.id)?.space).toBe("joint");

    const back = tasksRepo.update(t.id, { space: "personal" })!;
    expect(back.space).toBe("personal");
    expect(back.assignedTo).toBeNull();
    expect(tasksRepo.get(sub.id)?.space).toBe("personal");
  });

  it("only clears a sent reminder when the due moment changes", () => {
    const due = "2026-10-20T13:00:00.000Z";
    const t = tasksRepo.create({ title: "dentist", dueAt: due });
    tasksRepo.markNotified(t.id);
    const notified = () =>
      (db.prepare("SELECT notified_at FROM tasks WHERE id=?").get(t.id) as { notified_at: string | null })
        .notified_at;

    tasksRepo.update(t.id, { notes: "bring card", dueAt: "2026-10-20T13:00:00Z" });
    expect(notified()).not.toBeNull();
    tasksRepo.update(t.id, { dueAt: "2026-10-20T14:00:00.000Z" });
    expect(notified()).toBeNull();
  });

  it("never lets old done tasks crowd new open ones off a list", () => {
    const insert = db.prepare(
      `INSERT INTO tasks(id,title,status,space,due_at,completed_at,created_at,updated_at)
       VALUES(?,?,'done','joint',?,?,?,?)`
    );
    db.transaction(() => {
      for (let i = 0; i < 520; i++) {
        const at = new Date(Date.UTC(2025, 0, 1) + i * 3_600_000).toISOString();
        insert.run(`bulk-${i}`, `done ${i}`, at, at, at, at);
      }
    })();
    const milk = tasksRepo.create({ title: "milk", space: "joint" });
    const list = tasksRepo.list({ space: "joint", includeDone: true });
    expect(list.some((t) => t.id === milk.id)).toBe(true);
    const done = list.filter((t) => t.status === "done");
    expect(done.length).toBe(100);
    const ids = done.map((t) => t.id);
    expect(ids.indexOf("bulk-519")).toBeLessThan(ids.indexOf("bulk-518"));
    expect(ids).not.toContain("bulk-0");
    const stamps = done.map((t) => t.completedAt ?? "");
    expect([...stamps].sort((a, b) => b.localeCompare(a))).toEqual(stamps);
  });

  it("still keeps view=all to open tasks", () => {
    expect(tasksRepo.list({ space: "joint", view: "all" }).every((t) => t.status === "open")).toBe(true);
  });

  it("takes a search for % or _ literally", () => {
    tasksRepo.create({ title: "100% done" });
    tasksRepo.create({ title: "plain" });
    expect(tasksRepo.list({ q: "%" }).map((t) => t.title)).toEqual(["100% done"]);
    expect(tasksRepo.list({ q: "_" })).toEqual([]);
  });
});

describe("logbook", () => {
  it("removes exactly the entry tapped, and a repeat keeps its date", () => {
    const due = new Date(Date.now() + 86_400_000).toISOString();
    const t = tasksRepo.create({ title: "vitamins", dueAt: due, recurrence: { freq: "daily" } });
    for (const day of ["2026-10-19", "2026-10-20", "2026-10-21"]) {
      completionsRepo.log(t.id, t.title, `${day}T12:00:00.000Z`, day);
    }
    const entries = completionsRepo.logbook("2026-10-19", "2026-10-21").flatMap((d) => d.entries);
    const tuesday = entries.find((e) => e.taskId === t.id && e.completedAt.startsWith("2026-10-20"))!;
    expect(tuesday.id).toBeTruthy();

    const res = tasksRepo.unlog(tuesday.id)!;
    expect(res.removed).toBe(true);
    expect(res.reopened).toBe(false);
    expect(res.task?.dueAt).toBe(due);
    const left = completionsRepo
      .logbook("2026-10-19", "2026-10-21")
      .flatMap((d) => d.entries)
      .filter((e) => e.taskId === t.id)
      .map((e) => e.completedAt.slice(0, 10));
    expect(left.sort()).toEqual(["2026-10-19", "2026-10-21"]);
    expect(tasksRepo.unlog(tuesday.id)).toBeNull();
  });

  it("puts a one-off back on the list", () => {
    const t = tasksRepo.create({ title: "post letter" });
    tasksRepo.setDone(t.id, true);
    const entry = completionsRepo
      .logbook(today(), today())
      .flatMap((d) => d.entries)
      .find((e) => e.taskId === t.id)!;
    const res = tasksRepo.unlog(entry.id)!;
    expect(res.reopened).toBe(true);
    expect(res.task?.status).toBe("open");
  });

  it("leaves the entry alone when its task is gone", () => {
    const t = tasksRepo.create({ title: "temp" });
    tasksRepo.setDone(t.id, true);
    const entry = completionsRepo
      .logbook(today(), today())
      .flatMap((d) => d.entries)
      .find((e) => e.taskId === t.id)!;
    tasksRepo.remove(t.id);
    expect(tasksRepo.unlog(entry.id)).toEqual({ task: null, removed: false, reopened: false });
    expect(completionsRepo.get(entry.id)).not.toBeNull();
  });
});

describe("notes search", () => {
  it("matches checklist text, never the JSON around it, and takes % literally", () => {
    notesRepo.create({
      title: "Groceries",
      kind: "checklist",
      items: [{ id: "i1", text: "milk", done: false }],
    });
    notesRepo.create({ title: "Sure", content: "100% sure" });
    expect(notesRepo.list({ q: "one" }).map((n) => n.title)).toEqual([]);
    expect(notesRepo.list({ q: "milk" }).map((n) => n.title)).toEqual(["Groceries"]);
    expect(notesRepo.list({ q: "%" }).map((n) => n.title)).toEqual(["Sure"]);
    expect(notesRepo.list({ q: "_" })).toEqual([]);
  });
});

describe("import", () => {
  it("drops unknown and crafted column names instead of running them", () => {
    db.prepare(
      "INSERT INTO sessions(token, created_at, last_seen_at) VALUES('secret-token','x','x')"
    ).run();
    const crafted = "id,title,created_at,updated_at) SELECT token,token,token,token FROM sessions --";
    const res = importAll({
      version: 1,
      tasks: [
        { id: "imp-1", title: "Imported", created_at: "2026-01-01", updated_at: "2026-01-01", extra: 1, [crafted]: "x" },
      ],
    });
    expect(res.counts.tasks).toBe(1);
    expect(tasksRepo.get("imp-1")?.title).toBe("Imported");
    expect(db.prepare("SELECT COUNT(*) c FROM tasks WHERE title='secret-token'").get()).toEqual({ c: 0 });
  });

  it("brings back the inbox it exports", () => {
    db.prepare(
      "INSERT INTO inbox_items(id,source,external_id,content,received_at,created_at) VALUES('in-1','gmail','msg-1','hello','2026-01-01','2026-01-01')"
    ).run();
    const file = JSON.parse(JSON.stringify(exportAll())) as Record<string, unknown>;
    db.prepare("DELETE FROM inbox_items").run();
    const res = importAll(file);
    expect(res.counts.inbox).toBe(1);
    expect(repos.inboxRepo.get("in-1")?.externalId).toBe("msg-1");
  });

  it("refuses a bad file as a whole, with a reason", () => {
    const run = () =>
      importAll({
        version: 1,
        tasks: [
          { id: "imp-ok", title: "fine", created_at: "x", updated_at: "x" },
          { id: "imp-bad", title: "bad", tags: "not json", created_at: "x", updated_at: "x" },
        ],
      });
    expect(run).toThrow(ImportError);
    expect(tasksRepo.get("imp-ok")).toBeNull();
    expect(() => importAll({ version: 1, notes: "nope" })).toThrow(ImportError);
    expect(() => importAll({ version: 1, projects: [{ id: "p-x" }] })).toThrow(ImportError);
  });
});

describe("routes", () => {
  it("keeps a partner's #word in the title and out of the owner's projects", async () => {
    const { POST } = await import("@/app/api/tasks/route");
    session.role = "partner";
    const before = repos.projectsRepo.list(true).length;
    const res = await POST(req("/api/tasks", { method: "POST", body: { quick: "Buy charcoal #bbq", space: "joint" } }));
    const { task } = (await res.json()) as { task: { title: string; space: string; projectId: string | null } };
    expect(task.title).toBe("Buy charcoal #bbq");
    expect(task.space).toBe("joint");
    expect(task.projectId).toBeNull();
    expect(repos.projectsRepo.list(true).length).toBe(before);
  });

  it("still files the owner's personal #word into a project", async () => {
    const { POST } = await import("@/app/api/tasks/route");
    const res = await POST(req("/api/tasks", { method: "POST", body: { quick: "Call mom #family" } }));
    const { task } = (await res.json()) as { task: { title: string; projectId: string | null } };
    expect(task.title).toBe("Call mom");
    expect(repos.projectsRepo.get(task.projectId!)?.name).toBe("family");
  });

  it("lets a partner add subtasks under joint tasks only", async () => {
    const { POST } = await import("@/app/api/tasks/route");
    const joint = tasksRepo.create({ title: "Vacation", space: "joint" });
    const personal = tasksRepo.create({ title: "Private" });
    session.role = "partner";
    const ok = await POST(req("/api/tasks", { method: "POST", body: { title: "Pack", parentId: joint.id } }));
    const { task } = (await ok.json()) as { task: { parentId: string; space: string } };
    expect(task.parentId).toBe(joint.id);
    expect(task.space).toBe("joint");
    const denied = await POST(req("/api/tasks", { method: "POST", body: { title: "x", parentId: personal.id } }));
    expect(denied.status).toBe(404);
  });

  it("never lets a partner PATCH a task into a project or under a personal task", async () => {
    const { PATCH } = await import("@/app/api/tasks/[id]/route");
    const t = tasksRepo.create({ title: "Shared", space: "joint" });
    const personal = tasksRepo.create({ title: "Mine" });
    session.role = "partner";
    await PATCH(req(`/api/tasks/${t.id}`, { method: "PATCH", body: { projectId: "owner-project" } }), params(t.id));
    expect(tasksRepo.get(t.id)?.projectId).toBeNull();
    const res = await PATCH(
      req(`/api/tasks/${t.id}`, { method: "PATCH", body: { parentId: personal.id } }),
      params(t.id)
    );
    expect(res.status).toBe(404);
    expect(tasksRepo.get(t.id)?.parentId).toBeNull();
  });

  it("records a partner's tick as the partner's", async () => {
    const { POST } = await import("@/app/api/tasks/[id]/complete/route");
    const t = tasksRepo.create({ title: "Bread", space: "joint" });
    session.role = "partner";
    const res = await POST(req(`/api/tasks/${t.id}/complete`, { method: "POST", body: { done: true } }), params(t.id));
    expect(((await res.json()) as { changed: boolean }).changed).toBe(true);
    const row = db.prepare("SELECT completed_by FROM completions WHERE task_id=?").get(t.id) as {
      completed_by: string;
    };
    expect(row.completed_by).toBe("partner");
  });

  it("answers a bad import with a 400 and a reason", async () => {
    const { POST } = await import("@/app/api/data/import/route");
    const res = await POST(req("/api/data/import", { method: "POST", body: { version: 1, tasks: [{ title: "no id" }] } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/no id/);
  });

  it("takes one logbook entry out by id", async () => {
    const { DELETE } = await import("@/app/api/logbook/route");
    const t = tasksRepo.create({ title: "Stretch" });
    tasksRepo.setDone(t.id, true);
    const entry = completionsRepo
      .logbook(today(), today())
      .flatMap((d) => d.entries)
      .find((e) => e.taskId === t.id)!;
    const res = await DELETE(req(`/api/logbook?id=${entry.id}`, { method: "DELETE" }));
    expect(((await res.json()) as { reopened: boolean }).reopened).toBe(true);
    expect(completionsRepo.get(entry.id)).toBeNull();
  });
});

describe("review fixes", () => {
  const localTime = (iso: string) => localTimeKey(iso, TZ);

  it("refuses to nest a task under a subtask, or move one that has its own", async () => {
    const { POST } = await import("@/app/api/tasks/route");
    const { PATCH } = await import("@/app/api/tasks/[id]/route");
    const groceries = tasksRepo.create({ title: "Groceries", space: "joint" });
    const eggs = tasksRepo.create({ title: "eggs", parentId: groceries.id });
    const victim = tasksRepo.create({ title: "Victim", space: "joint" });

    session.role = "partner";
    const patched = await PATCH(
      req(`/api/tasks/${victim.id}`, { method: "PATCH", body: { parentId: eggs.id } }),
      params(victim.id)
    );
    expect(patched.status).toBe(400);
    expect(tasksRepo.get(victim.id)?.parentId).toBeNull();
    const posted = await POST(req("/api/tasks", { method: "POST", body: { title: "deep", parentId: eggs.id } }));
    expect(posted.status).toBe(400);

    // A cycle: the parent moved under its own subtask.
    session.role = "owner";
    const loop = await PATCH(
      req(`/api/tasks/${groceries.id}`, { method: "PATCH", body: { parentId: eggs.id } }),
      params(groceries.id)
    );
    expect(loop.status).toBe(400);
    const other = tasksRepo.create({ title: "Other" });
    const withKids = await PATCH(
      req(`/api/tasks/${groceries.id}`, { method: "PATCH", body: { parentId: other.id } }),
      params(groceries.id)
    );
    expect(withKids.status).toBe(400);
    expect(tasksRepo.get(groceries.id)?.parentId).toBeNull();
  });

  it("shows a project's whole done set, uncapped", () => {
    const insert = db.prepare(
      `INSERT INTO tasks(id,title,status,project_id,completed_at,created_at,updated_at)
       VALUES(?,?,'done','big-project',?,?,?)`
    );
    db.transaction(() => {
      for (let i = 0; i < 250; i++) {
        const at = new Date(Date.UTC(2025, 5, 1) + i * 60_000).toISOString();
        insert.run(`proj-done-${i}`, `done ${i}`, at, at, at);
      }
    })();
    const list = tasksRepo.list({ projectId: "big-project", includeDone: true });
    expect(list.filter((t) => t.status === "done").length).toBe(250);
  });

  describe("across DST", () => {
    afterAll(() => vi.useRealTimers());

    it("keeps a 02:30 daily at 02:30 after catching up through spring forward", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(isoFromLocal("2027-03-17", "12:00", TZ)));
      const t = tasksRepo.create({
        title: "late meds",
        dueAt: isoFromLocal("2027-03-12", "02:30", TZ),
        recurrence: { freq: "daily" },
      });
      const next = tasksRepo.setDone(t.id, true).task!.dueAt!;
      expect(localDateKey(next, TZ)).toBe("2027-03-18");
      expect(localTime(next)).toBe("02:30");
      vi.useRealTimers();
    });

    it("lands on the spring-forward day itself when that is the next occurrence", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(isoFromLocal("2027-03-13", "12:00", TZ)));
      const t = tasksRepo.create({
        title: "night dose",
        dueAt: isoFromLocal("2027-03-10", "02:30", TZ),
        recurrence: { freq: "daily" },
      });
      // 02:30 doesn't exist that night; only this one occurrence moves.
      const first = tasksRepo.setDone(t.id, true).task!.dueAt!;
      expect(localDateKey(first, TZ)).toBe("2027-03-14");
      expect(Date.parse(first)).toBeGreaterThan(Date.now());
      vi.useRealTimers();
    });

    it("keeps an 08:00 daily at 08:00 across fall back", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(isoFromLocal("2026-11-03", "12:00", TZ)));
      const t = tasksRepo.create({
        title: "walk",
        dueAt: isoFromLocal("2026-10-29", "08:00", TZ),
        recurrence: { freq: "daily" },
      });
      const next = tasksRepo.setDone(t.id, true).task!.dueAt!;
      expect(localDateKey(next, TZ)).toBe("2026-11-04");
      expect(localTime(next)).toBe("08:00");
      vi.useRealTimers();
    });
  });

  it("catches a years-old repeat up quickly, keeping its weekdays and phase", () => {
    const started = Date.now();
    const daily = tasksRepo.create({
      title: "ancient daily",
      dueAt: isoFromLocal("2000-01-03", "08:00", TZ),
      recurrence: { freq: "daily" },
    });
    const d = tasksRepo.setDone(daily.id, true).task!.dueAt!;
    expect(Date.parse(d)).toBeGreaterThan(Date.now());
    expect(Date.parse(d) - Date.now()).toBeLessThanOrEqual(25 * 3_600_000);
    expect(localTime(d)).toBe("08:00");

    const mwf = tasksRepo.create({
      title: "ancient mwf",
      dueAt: isoFromLocal("2000-01-03", "18:00", TZ),
      recurrence: { freq: "weekly", byWeekday: [1, 3, 5] },
    });
    const w = tasksRepo.setDone(mwf.id, true).task!.dueAt!;
    expect(Date.parse(w)).toBeGreaterThan(Date.now());
    expect([1, 3, 5]).toContain(new Date(`${localDateKey(w, TZ)}T12:00:00Z`).getUTCDay());

    // Every other Monday from Jan 3 2000: still an even number of weeks on.
    const fortnightly = tasksRepo.create({
      title: "ancient fortnightly",
      dueAt: isoFromLocal("2000-01-03", "09:00", TZ),
      recurrence: { freq: "weekly", interval: 2 },
    });
    const f = tasksRepo.setDone(fortnightly.id, true).task!.dueAt!;
    const days = Math.round(
      (Date.parse(`${localDateKey(f, TZ)}T00:00:00Z`) - Date.parse("2000-01-03T00:00:00Z")) / 86_400_000
    );
    expect(days % 14).toBe(0);
    expect(Date.parse(f)).toBeGreaterThan(Date.now());
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("clears hand-offs the subtask backfill moves to personal", async () => {
    const { alignSubtaskSpaces } = await import("@/lib/db");
    db.prepare(
      "INSERT INTO tasks(id,title,space,created_at,updated_at) VALUES('al-parent','mine','personal','x','x')"
    ).run();
    db.prepare(
      "INSERT INTO tasks(id,title,space,assigned_to,parent_id,created_at,updated_at) VALUES('al-child','kid','joint','partner','al-parent','x','x')"
    ).run();
    expect(alignSubtaskSpaces()).toBeGreaterThanOrEqual(1);
    const child = tasksRepo.get("al-child")!;
    expect(child.space).toBe("personal");
    expect(child.assignedTo).toBeNull();
  });

  it("aligns subtask lists after an import", () => {
    importAll({
      version: 1,
      tasks: [
        { id: "ia-parent", title: "ours", space: "joint", created_at: "x", updated_at: "x" },
        { id: "ia-child", title: "kid", space: "personal", parent_id: "ia-parent", created_at: "x", updated_at: "x" },
      ],
    });
    expect(tasksRepo.get("ia-child")?.space).toBe("joint");
  });

  it("refuses imported values the app can't read back", () => {
    const task = (extra: Record<string, unknown>) => ({
      id: `bad-${Math.random()}`,
      title: "t",
      created_at: "x",
      updated_at: "x",
      ...extra,
    });
    const bad: Record<string, unknown>[] = [
      { tasks: [task({ tags: 5 })] },
      { tasks: [task({ tags: '"str"' })] },
      { tasks: [task({ tags: "null" })] },
      { tasks: [task({ recurrence: { freq: "hourly" } })] },
      { tasks: [task({ recurrence: '{"freq":"weekly","byWeekday":3}' })] },
      { tasks: [task({ location: "[]" })] },
      { tasks: [task({ status: "weird" })] },
      { tasks: [task({ space: "other" })] },
      { notes: [{ id: "n-bad", items: "{}", created_at: "x", updated_at: "x" }] },
      { completions: [{ id: "c-bad", task_id: "t", completed_at: "x", date_local: "x", completed_by: "guest" }] },
      { inbox: [{ id: "i-bad", source: "sms", content: "c", received_at: "x", created_at: "x", suggestion: "[1]" }] },
    ];
    for (const file of bad) expect(() => importAll({ version: 1, ...file })).toThrow(ImportError);

    importAll({
      version: 1,
      tasks: [task({ id: "good-1", tags: ["a"], recurrence: { freq: "weekly", byWeekday: [1] }, location: null })],
    });
    const good = tasksRepo.get("good-1")!;
    expect(good.tags).toEqual(["a"]);
    expect(good.recurrence).toEqual({ freq: "weekly", byWeekday: [1] });
  });

  it("returns same-millisecond messages in the order they were added", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T12:00:00.000Z"));
    const conv = repos.conversationsRepo.create("tie");
    repos.conversationsRepo.addMessage(conv.id, "user", "hello");
    repos.conversationsRepo.addMessage(conv.id, "assistant", "not configured");
    vi.useRealTimers();
    expect(repos.conversationsRepo.messages(conv.id).map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("sweep fixes", () => {
  it("keeps a joint '#word' whole, even when the word is a date", async () => {
    const { POST } = await import("@/app/api/tasks/route");
    const add = async (quick: string, role: "owner" | "partner") => {
      session.role = role;
      const res = await POST(req("/api/tasks", { method: "POST", body: { quick, space: "joint" } }));
      return ((await res.json()) as { task: { title: string; dueAt: string | null; projectId: string | null } }).task;
    };
    const tomorrow = await add("call #tomorrow", "partner");
    expect(tomorrow.title).toBe("call #tomorrow");
    expect(tomorrow.dueAt).toBeNull();
    const meeting = await add("#3pm meeting", "partner");
    expect(meeting.title).toBe("#3pm meeting");
    expect(meeting.dueAt).toBeNull();
    expect((await add("Buy charcoal #bbq", "partner")).title).toBe("Buy charcoal #bbq");
    // The owner adding to the joint list takes the same path, and a real date
    // outside the "#word" still counts.
    const owner = await add("#bbq stuff tomorrow", "owner");
    expect(owner.title).toBe("#bbq stuff");
    expect(owner.dueAt).not.toBeNull();
    expect(owner.projectId).toBeNull();
  });

  it("treats an empty parentId as no parent", async () => {
    const { POST } = await import("@/app/api/tasks/route");
    const { PATCH } = await import("@/app/api/tasks/[id]/route");
    session.role = "partner";
    const milk = tasksRepo.create({ title: "Milk (empty parent)", space: "joint" });
    const patched = await PATCH(
      req(`/api/tasks/${milk.id}`, { method: "PATCH", body: { parentId: "" } }),
      params(milk.id)
    );
    expect(patched.status).toBe(200);
    expect(tasksRepo.get(milk.id)?.parentId).toBeNull();
    const posted = await POST(req("/api/tasks", { method: "POST", body: { title: "Eggs (empty parent)", parentId: "" } }));
    const { task } = (await posted.json()) as { task: { id: string; parentId: string | null } };
    expect(task.parentId).toBeNull();
    const titles = tasksRepo.list({ space: "joint", includeDone: true }).map((t) => t.title);
    expect(titles).toContain("Milk (empty parent)");
    expect(titles).toContain("Eggs (empty parent)");

    // The repo never stores one either.
    const direct = tasksRepo.create({ title: "direct", parentId: "" });
    expect(direct.parentId).toBeNull();
    expect(tasksRepo.update(direct.id, { parentId: "" })?.parentId).toBeNull();
    expect(
      (db.prepare("SELECT parent_id FROM tasks WHERE id=?").get(direct.id) as { parent_id: string | null })
        .parent_id
    ).toBeNull();
  });

  it("shows the owner's own ticks on the joint list in the Logbook, and can put them back", () => {
    const shared = tasksRepo.create({ title: "Shared chore", space: "joint" });
    const sub = tasksRepo.create({ title: "Shared sub", parentId: shared.id });
    const theirs = tasksRepo.create({ title: "Their chore", space: "joint" }, "partner");
    tasksRepo.setDone(shared.id, true);
    tasksRepo.setDone(sub.id, true);
    tasksRepo.setDone(theirs.id, true, { by: "partner" });
    const entries = completionsRepo.logbook(today(), today()).flatMap((d) => d.entries);
    const titles = entries.map((e) => e.title);
    expect(titles).toContain("Shared chore");
    expect(titles).toContain("Shared sub");
    expect(titles).not.toContain("Their chore");

    const entry = entries.find((e) => e.taskId === shared.id)!;
    const res = tasksRepo.unlog(entry.id)!;
    expect(res.reopened).toBe(true);
    expect(res.task?.status).toBe("open");
    expect(res.task?.space).toBe("joint");
  });

  // Last: it reopens the database, as a redeploy after a rollback would.
  it("realigns subtasks an older build misfiled after a rollback, on the next open", async () => {
    const parent = tasksRepo.create({ title: "Rollback parent", space: "joint" });
    const live = getDb();
    live
      .prepare(
        "INSERT INTO tasks(id,title,space,parent_id,created_at,updated_at) VALUES('rb-child','misfiled','personal',?,'x','x')"
      )
      .run(parent.id);
    live
      .prepare("INSERT INTO tasks(id,title,parent_id,created_at,updated_at) VALUES('rb-empty','hidden','','x','x')")
      .run();
    const g = globalThis as unknown as { __donexDb?: { close(): void } };
    g.__donexDb?.close();
    delete g.__donexDb;
    expect(tasksRepo.get("rb-child")?.space).toBe("joint");
    expect(tasksRepo.list({}).map((t) => t.id)).toContain("rb-empty");
  });
});
