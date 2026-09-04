import { describe, expect, it } from "vitest";
import {
  applyOps,
  classifyRequest,
  rewriteIds,
  synthesizeTask,
  type OutboxOp,
} from "@/lib/offline";
import type { Task } from "@/lib/types";

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
