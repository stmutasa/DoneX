import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyOps,
  classifyRequest,
  rewriteIds,
  synthesizeTask,
  type OutboxOp,
} from "@/lib/offline";
import type { SessionRole, Task } from "@/lib/types";

const baseTask = (over: Partial<Task>): Task => ({
  id: "t1",
  title: "Existing task",
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
  createdAt: "2026-08-15T12:00:00.000Z",
  updatedAt: "2026-08-15T12:00:00.000Z",
  subtasks: [],
  ...over,
});

const op = (over: Partial<OutboxOp>): OutboxOp => ({
  id: "op1",
  kind: "task-complete",
  method: "POST",
  url: "/api/tasks/t1/complete",
  body: JSON.stringify({ done: true }),
  queuedAt: "2026-08-15T13:00:00.000Z",
  ...over,
});

const create = (synth: Task): OutboxOp =>
  op({ id: `c-${synth.id}`, kind: "task-create", method: "POST", url: "/api/tasks", offlineId: synth.id, synth });
const patch = (id: string, body: Partial<Task>): OutboxOp =>
  op({ id: `u-${id}`, kind: "task-update", method: "PATCH", url: `/api/tasks/${id}`, body: JSON.stringify(body) });

describe("classifyRequest", () => {
  it("recognises the four queueable task writes", () => {
    expect(classifyRequest("POST", "/api/tasks")).toBe("task-create");
    expect(classifyRequest("POST", "/api/tasks/abc/complete")).toBe("task-complete");
    expect(classifyRequest("PATCH", "/api/tasks/abc")).toBe("task-update");
    expect(classifyRequest("DELETE", "/api/tasks/abc")).toBe("task-delete");
  });

  it("refuses everything else", () => {
    expect(classifyRequest("POST", "/api/notes")).toBeNull();
    expect(classifyRequest("POST", "/api/tasks/reorder")).toBeNull();
    expect(classifyRequest("POST", "/api/inbox")).toBeNull();
    expect(classifyRequest("GET", "/api/tasks")).toBeNull();
    expect(classifyRequest("POST", "/api/chat")).toBeNull();
  });
});

describe("synthesizeTask", () => {
  it("builds a full task from a draft body", () => {
    const t = synthesizeTask(
      { title: "Buy nails", priority: 2, dueAt: "2026-08-16T04:00:00.000Z", dueKind: "by" },
      "off_x",
    );
    expect(t.id).toBe("off_x");
    expect(t.title).toBe("Buy nails");
    expect(t.priority).toBe(2);
    expect(t.dueKind).toBe("by");
    expect(t.status).toBe("open");
  });

  it("uses the raw text as the title for quick captures", () => {
    const t = synthesizeTask({ quick: "call mom tomorrow" }, "off_y");
    expect(t.title).toBe("call mom tomorrow");
    expect(t.dueAt).toBeNull();
  });

  it("leaves projectId off a quick capture, as the server does", () => {
    expect(synthesizeTask({ quick: "buy milk", projectId: "p1" }, "off_z").projectId).toBeNull();
  });

  it("credits whoever queued it", () => {
    expect(synthesizeTask({ title: "x" }, "off_p", "partner").createdBy).toBe("partner");
    expect(synthesizeTask({ title: "x" }, "off_o").createdBy).toBe("owner");
  });
});

describe("applyOps overlay", () => {
  it("marks a queued completion done on includeDone lists and drops it elsewhere", () => {
    const data = { tasks: [baseTask({})] };
    const withDone = applyOps("/api/tasks?view=today&includeDone=1", data, [op({})]);
    expect(withDone.tasks[0].status).toBe("done");
    const without = applyOps("/api/tasks?view=today", data, [op({})]);
    expect(without.tasks).toHaveLength(0);
  });

  it("applies queued patches and deletes", () => {
    const data = { tasks: [baseTask({}), baseTask({ id: "t2", title: "Second" })] };
    const out = applyOps("/api/tasks", data, [
      op({ kind: "task-update", method: "PATCH", url: "/api/tasks/t1", body: JSON.stringify({ title: "Renamed" }) }),
      op({ kind: "task-delete", method: "DELETE", url: "/api/tasks/t2", body: null }),
    ]);
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks[0].title).toBe("Renamed");
  });

  it("injects offline creates into the views they belong to", () => {
    const synth = synthesizeTask({ title: "Undated" }, "off_a");
    const creation = op({ kind: "task-create", method: "POST", url: "/api/tasks", offlineId: "off_a", synth });
    expect(applyOps("/api/tasks?view=anytime", { tasks: [] }, [creation]).tasks).toHaveLength(1);
    expect(applyOps("/api/tasks?view=today", { tasks: [] }, [creation]).tasks).toHaveLength(0);
    expect(applyOps("/api/tasks", { tasks: [] }, [creation]).tasks).toHaveLength(1);
  });

  it("leaves non-list keys and foreign keys untouched", () => {
    const data = { notes: [1, 2, 3] };
    expect(applyOps("/api/notes", data, [op({})])).toBe(data);
  });

  it("keeps offline creates out of project, tag and search lists they don't match", () => {
    const loose = create(synthesizeTask({ title: "Call plumber" }, "off_a"));
    const filed = create(synthesizeTask({ title: "Ship it", projectId: "W", tags: ["Home"] }, "off_b"));
    const ids = (key: string) =>
      applyOps(key, { tasks: [] as Task[] }, [loose, filed]).tasks.map((t) => t.id);

    expect(ids("/api/tasks?projectId=W&includeDone=1")).toEqual(["off_b"]);
    expect(ids("/api/tasks?projectId=X&includeDone=1")).toEqual([]);
    expect(ids("/api/tasks?view=anytime&excludeProjects=1")).toEqual(["off_a"]);
    expect(ids("/api/tasks?tag=home")).toEqual(["off_b"]);
    expect(ids("/api/tasks?tag=work")).toEqual([]);
    expect(ids("/api/tasks?q=PLUMB")).toEqual(["off_a"]);
  });

  it("moves a task out of a list when a queued edit stops it matching", () => {
    const data = { tasks: [baseTask({})] };
    expect(applyOps("/api/tasks?view=anytime&excludeProjects=1", data, [patch("t1", { projectId: "W" })]).tasks).toHaveLength(0);
    expect(
      applyOps("/api/tasks?view=anytime", data, [patch("t1", { dueAt: "2099-01-01T09:00:00.000Z" })]).tasks,
    ).toHaveLength(0);
    // An edit to fields no filter reads leaves the server's choice alone.
    const listed = { tasks: [baseTask({ dueAt: null })] };
    expect(applyOps("/api/tasks?view=today", listed, [patch("t1", { title: "Renamed" })]).tasks[0].title).toBe(
      "Renamed",
    );
  });

  it("brings an offline create into a list once a queued edit makes it match", () => {
    const synth = synthesizeTask({ quick: "Buy filters" }, "off_q");
    const ops = [create(synth), patch("off_q", { projectId: "W" })];
    const onProject = applyOps("/api/tasks?projectId=W&includeDone=1", { tasks: [] as Task[] }, ops).tasks;
    expect(onProject.map((t) => [t.id, t.projectId, t.title])).toEqual([["off_q", "W", "Buy filters"]]);
    expect(applyOps("/api/tasks?view=anytime&excludeProjects=1", { tasks: [] }, ops).tasks).toHaveLength(0);
  });

  it("keeps a future deadline in Upcoming, as the server lists it", () => {
    const data = { tasks: [baseTask({ dueAt: "2099-01-05T09:00:00.000Z", dueKind: "by" })] };
    const moved = applyOps("/api/tasks?view=upcoming", data, [patch("t1", { dueAt: "2099-01-09T09:00:00.000Z" })]);
    expect(moved.tasks.map((t) => t.dueAt)).toEqual(["2099-01-09T09:00:00.000Z"]);
    const synth = synthesizeTask({ title: "Tax", dueAt: "2099-01-05T09:00:00.000Z", dueKind: "by" }, "off_t");
    expect(applyOps("/api/tasks?view=upcoming", { tasks: [] as Task[] }, [create(synth)]).tasks).toHaveLength(1);
  });

  it("drops a completion from Upcoming even when done tasks are asked for", () => {
    const data = { tasks: [baseTask({ dueAt: "2099-01-01T09:00:00.000Z" })] };
    expect(applyOps("/api/tasks?view=upcoming&includeDone=1", data, [op({})]).tasks).toHaveLength(0);
    expect(applyOps("/api/tasks?includeDone=1", data, [op({})]).tasks[0].status).toBe("done");
  });
});

describe("rewriteIds", () => {
  it("substitutes server ids into queued urls and bodies", () => {
    const patched = rewriteIds(
      op({
        kind: "task-update",
        method: "PATCH",
        url: "/api/tasks/off_a",
        body: JSON.stringify({ parentId: "off_a" }),
      }),
      { off_a: "real-1" },
    );
    expect(patched.url).toBe("/api/tasks/real-1");
    expect(patched.body).toContain("real-1");
    expect(patched.body).not.toContain("off_a");
  });

  it("is a no-op with an empty map", () => {
    const original = op({});
    expect(rewriteIds(original, {})).toEqual(original);
  });
});

// ── The outbox as tabs and sign-ins share it ───────────────────────────────

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

type OfflineModule = typeof import("@/lib/offline");

/** A fresh module instance: a new tab, or the page reloading. */
async function openTab(): Promise<OfflineModule> {
  vi.resetModules();
  return import("@/lib/offline");
}

interface Call {
  method: string;
  url: string;
  body?: string;
}

/** A fake API: who the cookie belongs to, and how task writes answer. */
function serve(opts: {
  role: SessionRole | null;
  status?: (call: Call) => number;
  onWrite?: (call: Call) => void;
  /** hold a write's answer back until the promise settles */
  hold?: (call: Call) => Promise<void> | undefined;
  meFromCache?: boolean;
}) {
  const writes: Call[] = [];
  let n = 0;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { method: init?.method ?? "GET", url, body: init?.body as string | undefined };
      if (url === "/api/auth/me") {
        if (!opts.role) return json({ error: "Unauthorized" }, 401);
        return json({ role: opts.role }, 200, opts.meFromCache ? { "x-donex-cache": "1" } : {});
      }
      writes.push(call);
      opts.onWrite?.(call);
      await opts.hold?.(call);
      const status = opts.status?.(call) ?? 200;
      if (status !== 200) return json({ error: "nope" }, status);
      if (call.method === "POST" && url === "/api/tasks") return json({ task: { id: `srv_${++n}` } });
      return json({ ok: true });
    }),
  );
  return writes;
}

const quick = (text: string) => JSON.stringify({ quick: text });

describe("outbox across sessions and tabs", () => {
  let store: MemoryStorage;

  beforeEach(() => {
    store = new MemoryStorage();
    vi.stubGlobal("localStorage", store);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never replays the owner's queued changes under a partner sign-in", async () => {
    const owner = await openTab();
    owner.noteSessionRole("owner");
    owner.enqueueFailedRequest("POST", "/api/tasks", quick("Book therapist appt"));
    owner.enqueueFailedRequest("PATCH", "/api/tasks/t1", JSON.stringify({ title: "Private" }));

    // The partner signs in on the same device.
    const partner = await openTab();
    let writes = serve({ role: "partner" });
    const result = await partner.syncOutbox();
    expect(writes).toEqual([]);
    expect(result).toEqual({ synced: 0, dropped: 0, remaining: 0 });
    expect(partner.outboxCount()).toBe(0);
    expect(partner.applyOutboxOverlay("/api/tasks?space=joint", { tasks: [] as Task[] }).tasks).toEqual([]);

    // The owner's next sign-in sends them, in order.
    const back = await openTab();
    writes = serve({ role: "owner" });
    expect(await back.syncOutbox()).toEqual({ synced: 2, dropped: 0, remaining: 0 });
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual(["POST /api/tasks", "PATCH /api/tasks/t1"]);
  });

  it("gives ops from before roles were kept to the first live sign-in, but never a personal create", async () => {
    const personal = synthesizeTask({ quick: "Book therapist appt" }, "off_old");
    store.setItem(
      "donex.outbox.v1",
      JSON.stringify([
        op({ id: "c", kind: "task-create", method: "POST", url: "/api/tasks", offlineId: "off_old", synth: personal, body: quick("Book therapist appt") }),
        op({ id: "d", kind: "task-delete", method: "DELETE", url: "/api/tasks/t9", body: null }),
      ]),
    );

    let writes = serve({ role: "partner" });
    await (await openTab()).syncOutbox();
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual(["DELETE /api/tasks/t9"]);

    writes = serve({ role: "owner" });
    await (await openTab()).syncOutbox();
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual(["POST /api/tasks"]);
  });

  it("waits for a live answer about the session before replaying", async () => {
    const tab = await openTab();
    tab.noteSessionRole("owner");
    tab.enqueueFailedRequest("POST", "/api/tasks", quick("Buy milk"));

    const writes = serve({ role: "owner", meFromCache: true });
    expect((await tab.syncOutbox()).remaining).toBe(1);
    expect(writes).toEqual([]);
  });

  it("keeps the queue on a 401 instead of dropping it", async () => {
    const tab = await openTab();
    tab.noteSessionRole("partner");
    tab.enqueueFailedRequest("POST", "/api/tasks", JSON.stringify({ quick: "Milk", space: "joint" }));
    tab.enqueueFailedRequest("POST", "/api/tasks/t2/complete", JSON.stringify({ done: true }));

    // Signed out before the replay starts…
    let writes = serve({ role: null });
    expect(await tab.syncOutbox()).toEqual({ synced: 0, dropped: 0, remaining: 2 });
    expect(writes).toEqual([]);

    // …or during it.
    writes = serve({ role: "partner", status: () => 401 });
    expect(await tab.syncOutbox()).toEqual({ synced: 0, dropped: 0, remaining: 2 });
    expect(writes).toHaveLength(1);

    // Signed back in: everything lands.
    serve({ role: "partner" });
    expect(await tab.syncOutbox()).toEqual({ synced: 2, dropped: 0, remaining: 0 });
  });

  it("keeps server trouble for later and drops definite rejections", async () => {
    const tab = await openTab();
    tab.noteSessionRole("owner");
    tab.enqueueFailedRequest("PATCH", "/api/tasks/gone", JSON.stringify({ title: "x" }));
    tab.enqueueFailedRequest("POST", "/api/tasks", quick("Next"));

    serve({ role: "owner", status: () => 503 });
    expect(await tab.syncOutbox()).toEqual({ synced: 0, dropped: 0, remaining: 2 });
    serve({ role: "owner", status: () => 429 });
    expect(await tab.syncOutbox()).toEqual({ synced: 0, dropped: 0, remaining: 2 });

    serve({ role: "owner", status: (c) => (c.url === "/api/tasks/gone" ? 404 : 200) });
    expect(await tab.syncOutbox()).toEqual({ synced: 1, dropped: 1, remaining: 0 });
  });

  it("lets only one tab replay at a time (storage lease)", async () => {
    const seed = await openTab();
    seed.noteSessionRole("owner");
    seed.enqueueFailedRequest("POST", "/api/tasks", quick("Buy milk"));

    const a = await openTab();
    const b = await openTab();
    const writes = serve({ role: "owner" });
    await Promise.all([a.syncOutbox(), b.syncOutbox()]);
    expect(writes).toHaveLength(1);
    expect(store.getItem("donex.outbox.lease.v1")).toBeNull();
  });

  it("lets only one tab replay at a time (Web Locks)", async () => {
    const held = new Set<string>();
    vi.stubGlobal("navigator", {
      locks: {
        request: async (name: string, _opts: unknown, cb: (lock: unknown) => Promise<unknown>) => {
          if (held.has(name)) return cb(null);
          held.add(name);
          try {
            return await cb({ name });
          } finally {
            held.delete(name);
          }
        },
      },
    });
    const seed = await openTab();
    seed.noteSessionRole("owner");
    seed.enqueueFailedRequest("POST", "/api/tasks", quick("Buy milk"));

    const a = await openTab();
    const b = await openTab();
    const writes = serve({ role: "owner" });
    await Promise.all([a.syncOutbox(), b.syncOutbox()]);
    expect(writes).toHaveLength(1);
  });

  it("doesn't lose a change another tab queues while one is replaying", async () => {
    const a = await openTab();
    a.noteSessionRole("owner");
    a.enqueueFailedRequest("POST", "/api/tasks", quick("First"));
    const b = await openTab();
    b.noteSessionRole("owner");

    let queuedInB = false;
    const writes = serve({
      role: "owner",
      onWrite: () => {
        if (queuedInB) return;
        queuedInB = true;
        b.enqueueFailedRequest("POST", "/api/tasks", quick("Second"));
      },
    });
    expect(await a.syncOutbox()).toEqual({ synced: 2, dropped: 0, remaining: 0 });
    expect(writes.map((w) => JSON.parse(w.body ?? "{}").quick)).toEqual(["First", "Second"]);
    expect(JSON.parse(store.getItem("donex.outbox.v1") ?? "[]")).toEqual([]);
  });

  it("replays a tick's expectedDueAt, except on a task created offline", async () => {
    const tab = await openTab();
    tab.noteSessionRole("owner");
    const created = tab.enqueueFailedRequest("POST", "/api/tasks", quick("Meds every day 9am")) as {
      task: Task;
    };
    const due = "2026-10-27T13:00:00.000Z";
    tab.enqueueFailedRequest(
      "POST",
      `/api/tasks/${created.task.id}/complete`,
      JSON.stringify({ done: true, expectedDueAt: null }),
    );
    tab.enqueueFailedRequest("POST", "/api/tasks/t5/complete", JSON.stringify({ done: true, expectedDueAt: due }));

    const writes = serve({ role: "owner" });
    expect(await tab.syncOutbox()).toEqual({ synced: 3, dropped: 0, remaining: 0 });
    expect(writes.slice(1).map((w) => [w.url, JSON.parse(w.body ?? "{}")])).toEqual([
      ["/api/tasks/srv_1/complete", { done: true }],
      ["/api/tasks/t5/complete", { done: true, expectedDueAt: due }],
    ]);
  });

  it("answers an offline edit of an offline task with the whole task", async () => {
    const tab = await openTab();
    tab.noteSessionRole("owner");
    const created = tab.enqueueFailedRequest(
      "POST",
      "/api/tasks",
      JSON.stringify({ quick: "Buy filters", projectId: "W" }),
    ) as { task: Task };
    const edited = tab.enqueueFailedRequest(
      "PATCH",
      `/api/tasks/${created.task.id}`,
      JSON.stringify({ projectId: "W" }),
    ) as { task: Task };
    expect(edited.task).toMatchObject({ id: created.task.id, title: "Buy filters", status: "open", projectId: "W" });
    const onProject = tab.applyOutboxOverlay("/api/tasks?projectId=W&includeDone=1", { tasks: [] as Task[] });
    expect(onProject.tasks.map((t) => t.title)).toEqual(["Buy filters"]);
  });

  describe("sign-out", () => {
    const stubCaches = (urls: string[]) => {
      const entries = new Set(urls);
      const cache = {
        keys: async () => [...entries].map((url) => ({ url })),
        delete: async (r: { url: string }) => entries.delete(r.url),
      };
      vi.stubGlobal("caches", { has: async (n: string) => n === "donex-data-v1", open: async () => cache });
      return entries;
    };

    /** signOutThisDevice's order: flush while live, logout, then clear. */
    async function signOut(tab: OfflineModule) {
      const left = await tab.flushOutboxBeforeSignOut();
      serve({ role: null }); // the logout has ended the session
      tab.forgetSessionRole();
      await tab.clearLocalDataOnSignOut();
      return left;
    }

    it("lands the queue while the session is live, then forgets it and the cached reads", async () => {
      const cached = stubCaches([
        "https://donex.test/api/tasks?view=today",
        "https://donex.test/api/settings",
        "https://donex.test/today",
        "https://donex.test/_next/static/chunks/app.js",
        "https://donex.test/icons/icon-192.png",
      ]);
      const tab = await openTab();
      tab.noteSessionRole("owner");
      tab.enqueueFailedRequest("POST", "/api/tasks", quick("Before I go"));
      tab.enqueueFailedRequest("PATCH", "/api/tasks/t1", JSON.stringify({ title: "Too" }));

      const writes = serve({ role: "owner" });
      expect(await signOut(tab)).toBe(0);

      expect(writes.map((w) => w.method)).toEqual(["POST", "PATCH"]);
      expect(tab.outboxCount()).toBe(0);
      expect(store.length).toBe(0);
      expect([...cached]).toEqual([
        "https://donex.test/_next/static/chunks/app.js",
        "https://donex.test/icons/icon-192.png",
      ]);
    });

    it("reports what couldn't be sent, and a clear after logout asks nothing", async () => {
      stubCaches([]);
      const tab = await openTab();
      tab.noteSessionRole("owner");
      tab.enqueueFailedRequest("POST", "/api/tasks", quick("Kept by a 503"));
      serve({ role: "owner", status: () => 503 });
      expect(await signOut(tab)).toBe(1);
      // signOut swapped in a fresh fake API before the clear, which never used it.
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      expect(tab.outboxCount()).toBe(0);
      expect(store.getItem("donex.outbox.v1")).toBeNull();
    });

    it("waits for a replay already running in this tab", async () => {
      stubCaches([]);
      const tab = await openTab();
      tab.noteSessionRole("owner");
      tab.enqueueFailedRequest("POST", "/api/tasks", quick("One"));
      tab.enqueueFailedRequest("POST", "/api/tasks", quick("Two"));

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const writes = serve({ role: "owner", hold: (c) => (JSON.parse(c.body ?? "{}").quick === "One" ? gate : undefined) });
      const running = tab.syncOutbox();
      await vi.waitFor(() => expect(writes).toHaveLength(1));

      const flushed = tab.flushOutboxBeforeSignOut();
      setTimeout(release, 50);
      expect(await flushed).toBe(0);
      await running;
      expect(writes.map((w) => JSON.parse(w.body ?? "{}").quick)).toEqual(["One", "Two"]);
    });

    it("waits for another tab's replay (Web Locks)", async () => {
      stubCaches([]);
      // A lock manager that queues waiters and honours an abort signal.
      const waiters: (() => void)[] = [];
      let held = false;
      vi.stubGlobal("navigator", {
        locks: {
          request: async (
            _name: string,
            opts: { ifAvailable?: boolean; signal?: AbortSignal },
            cb: (lock: unknown) => Promise<unknown>,
          ) => {
            if (held) {
              if (opts.ifAvailable) return cb(null);
              await new Promise<void>((resolve, reject) => {
                waiters.push(resolve);
                opts.signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")));
              });
            }
            held = true;
            try {
              return await cb({});
            } finally {
              held = false;
              waiters.shift()?.();
            }
          },
        },
      });
      const other = await openTab();
      other.noteSessionRole("owner");
      other.enqueueFailedRequest("POST", "/api/tasks", quick("One"));
      other.enqueueFailedRequest("POST", "/api/tasks", quick("Two"));

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const writes = serve({ role: "owner", hold: (c) => (JSON.parse(c.body ?? "{}").quick === "One" ? gate : undefined) });
      const running = other.syncOutbox();
      await vi.waitFor(() => expect(writes).toHaveLength(1));

      const me = await openTab();
      me.noteSessionRole("owner");
      const flushed = me.flushOutboxBeforeSignOut();
      setTimeout(release, 50);
      expect(await flushed).toBe(0);
      await running;
      expect(writes).toHaveLength(2);
    });

    it("stops a replay that outlives the clear, and writes nothing back", async () => {
      stubCaches([]);
      const tab = await openTab();
      tab.noteSessionRole("owner");
      tab.enqueueFailedRequest("POST", "/api/tasks", quick("One"));
      tab.enqueueFailedRequest("POST", "/api/tasks", quick("Two"));

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const writes = serve({ role: "owner", hold: () => gate });
      expect(await tab.flushOutboxBeforeSignOut(100)).toBe(2);
      await tab.clearLocalDataOnSignOut();
      release();
      await vi.waitFor(() => expect(tab.outboxSyncing()).toBe(false));
      expect(writes).toHaveLength(1);
      expect(store.getItem("donex.outbox.map.v1")).toBeNull();
      expect(store.getItem("donex.outbox.v1")).toBeNull();
    });

    it("stops another tab's replay when this tab signs out", async () => {
      stubCaches([]);
      const other = await openTab();
      other.noteSessionRole("owner");
      other.enqueueFailedRequest("POST", "/api/tasks", quick("One"));
      other.enqueueFailedRequest("POST", "/api/tasks", quick("Two"));

      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const writes = serve({ role: "owner", hold: (c) => (JSON.parse(c.body ?? "{}").quick === "One" ? gate : undefined) });
      const running = other.syncOutbox();
      await vi.waitFor(() => expect(writes).toHaveLength(1));

      // This tab gives up waiting for the other's lease, then signs out.
      const me = await openTab();
      me.noteSessionRole("owner");
      expect(await me.flushOutboxBeforeSignOut(100)).toBe(2);
      me.forgetSessionRole();
      await me.clearLocalDataOnSignOut();

      release();
      await running;
      expect(writes).toHaveLength(1);
      expect(store.getItem("donex.outbox.map.v1")).toBeNull();
      expect(store.getItem("donex.outbox.v1")).toBeNull();
    });

    it("merges the id map instead of overwriting entries written meanwhile", async () => {
      const tab = await openTab();
      tab.noteSessionRole("owner");
      const created = tab.enqueueFailedRequest("POST", "/api/tasks", quick("One")) as { task: Task };
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const writes = serve({ role: "owner", hold: () => gate });
      const running = tab.syncOutbox();
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      store.setItem("donex.outbox.map.v1", JSON.stringify({ off_elsewhere: "srv_x" }));
      release();
      await running;
      expect(JSON.parse(store.getItem("donex.outbox.map.v1") ?? "{}")).toEqual({
        off_elsewhere: "srv_x",
        [created.task.id]: "srv_1",
      });
    });

    it("keeps the other role's queued ops, and the id map entries they need", async () => {
      stubCaches([]);
      const owner = await openTab();
      owner.noteSessionRole("owner");
      const created = owner.enqueueFailedRequest("POST", "/api/tasks", quick("Mine")) as { task: Task };
      owner.enqueueFailedRequest("PATCH", `/api/tasks/${created.task.id}`, JSON.stringify({ title: "Mine!" }));
      store.setItem(
        "donex.outbox.map.v1",
        JSON.stringify({ [created.task.id]: "srv_9", off_stale: "srv_0" }),
      );

      const partner = await openTab();
      serve({ role: "partner" });
      await partner.syncOutbox();
      partner.enqueueFailedRequest("POST", "/api/tasks", JSON.stringify({ quick: "Ours", space: "joint" }));
      partner.forgetSessionRole();
      await partner.clearLocalDataOnSignOut();

      const left = JSON.parse(store.getItem("donex.outbox.v1") ?? "[]") as OutboxOp[];
      expect(left.map((o) => [o.role, o.method])).toEqual([
        ["owner", "POST"],
        ["owner", "PATCH"],
      ]);
      expect(JSON.parse(store.getItem("donex.outbox.map.v1") ?? "{}")).toEqual({
        [created.task.id]: "srv_9",
      });
      expect(store.getItem("donex.outbox.role.v1")).toBeNull();
    });
  });

  it("drops the last person's cached reads when someone else signs in, and says when", async () => {
    const cache = new Set(["https://donex.test/api/settings"]);
    vi.stubGlobal("caches", {
      has: async () => true,
      open: async () => ({
        keys: async () => [...cache].map((url) => ({ url })),
        delete: async (r: { url: string }) => cache.delete(r.url),
      }),
    });
    await (await openTab()).noteSessionRole("owner");
    const next = await openTab();
    await next.noteSessionRole("owner");
    expect(cache.size).toBe(1);
    await next.noteSessionRole("partner");
    expect(cache.size).toBe(0);
  });

  it("tags offline ops from a cached me, without confirming or purging", async () => {
    const purged = vi.fn(async () => false);
    vi.stubGlobal("caches", { has: purged });
    const tab = await openTab();
    tab.noteCachedSessionRole("partner");
    tab.enqueueFailedRequest("POST", "/api/tasks", JSON.stringify({ quick: "Ours", space: "joint" }));
    const [queued] = JSON.parse(store.getItem("donex.outbox.v1") ?? "[]") as OutboxOp[];
    expect(queued.role).toBe("partner");
    expect(tab.outboxSessionRole()).toBeNull();
    // A cached answer never overrides a role this device already knows.
    tab.noteCachedSessionRole("owner");
    expect(JSON.parse(store.getItem("donex.outbox.role.v1") ?? "null")).toBe("partner");
    expect(purged).not.toHaveBeenCalled();
  });

  it("gives ops queued before the role was known to the first live sign-in", async () => {
    const tab = await openTab();
    tab.enqueueFailedRequest("POST", "/api/tasks", JSON.stringify({ quick: "Ours", space: "joint" }));
    const ours = (
      tab.enqueueFailedRequest("POST", "/api/tasks", JSON.stringify({ title: "Joint draft", space: "joint" })) as {
        task: Task;
      }
    ).task;
    tab.enqueueFailedRequest("POST", `/api/tasks/${ours.id}/complete`, JSON.stringify({ done: true }));
    const mine = (tab.enqueueFailedRequest("POST", "/api/tasks", quick("Personal")) as { task: Task }).task;
    tab.enqueueFailedRequest("PATCH", `/api/tasks/${mine.id}`, JSON.stringify({ title: "Personal!" }));
    const queued = JSON.parse(store.getItem("donex.outbox.v1") ?? "[]") as OutboxOp[];
    expect(queued.every((o) => o.roleUnknown && !o.role)).toBe(true);

    const writes = serve({ role: "partner" });
    expect(await tab.syncOutbox()).toEqual({ synced: 3, dropped: 0, remaining: 0 });
    expect(writes.map((w) => `${w.method} ${w.url}`)).toEqual([
      "POST /api/tasks",
      "POST /api/tasks",
      "POST /api/tasks/srv_2/complete",
    ]);
    // A personal create can only be the owner's, and so is the edit to it.
    const left = JSON.parse(store.getItem("donex.outbox.v1") ?? "[]") as OutboxOp[];
    expect(left.map((o) => [o.role, o.method, o.roleUnknown])).toEqual([
      ["owner", "POST", undefined],
      ["owner", "PATCH", undefined],
    ]);
  });

  it("skips, rather than drops, an op whose create waits for another role", async () => {
    const synth = synthesizeTask({ title: "Owner's", space: "joint" }, "off_w");
    store.setItem(
      "donex.outbox.v1",
      JSON.stringify([
        op({ id: "c", kind: "task-create", method: "POST", url: "/api/tasks", offlineId: "off_w", synth, role: "owner" }),
        op({ id: "u", kind: "task-update", method: "PATCH", url: "/api/tasks/off_w", body: "{}", role: "partner" }),
        op({ id: "d", kind: "task-delete", method: "DELETE", url: "/api/tasks/t3", body: null, role: "partner" }),
      ]),
    );
    const writes = serve({ role: "partner" });
    expect(await (await openTab()).syncOutbox()).toEqual({ synced: 1, dropped: 0, remaining: 1 });
    expect(writes.map((w) => w.url)).toEqual(["/api/tasks/t3"]);
    expect((JSON.parse(store.getItem("donex.outbox.v1") ?? "[]") as OutboxOp[]).map((o) => o.id)).toEqual([
      "c",
      "u",
    ]);
  });

  it("splits Today from Upcoming at midnight in the app's zone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-27T05:00:00.000Z"));
    try {
      const tab = await openTab();
      // 19:00 on the 27th in Kiritimati (UTC+14): its midnight is 10:00Z.
      tab.noteAppZone("Pacific/Kiritimati");
      const data = { tasks: [baseTask({ dueAt: "2026-10-27T12:00:00.000Z" })] };
      expect(tab.applyOps("/api/tasks?view=upcoming", data, [patch("t1", { title: "x" })]).tasks).toHaveLength(1);
      expect(
        tab.applyOps("/api/tasks?view=today", data, [patch("t1", { dueAt: "2026-10-27T12:00:00.000Z" })]).tasks,
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
