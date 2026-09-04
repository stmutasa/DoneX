import { describe, expect, it } from "vitest";
import { assignmentAlert, nameFor } from "@/lib/assign";
import type { Task } from "@/lib/types";

const names = { owner: "Sam", partner: "Maya" };

const task = (over: Partial<Task> = {}) =>
  ({
    id: "t1",
    title: "book the table",
    space: "joint",
    assignedTo: null,
    ...over,
  }) as Pick<Task, "id" | "title" | "space" | "assignedTo">;

describe("assignmentAlert", () => {
  it("alerts the partner when the owner tags them", () => {
    const alert = assignmentAlert({
      task: task({ assignedTo: "partner" }),
      actor: "owner",
      names,
    });
    expect(alert).toMatchObject({
      to: "partner",
      title: "Sam tagged you",
      body: "book the table",
      url: "/joint",
    });
  });

  it("alerts the owner when the partner tags them back", () => {
    const alert = assignmentAlert({
      task: task({ assignedTo: "owner" }),
      actor: "partner",
      names,
    });
    expect(alert?.to).toBe("owner");
    expect(alert?.title).toBe("Maya tagged you");
  });

  it("stays quiet when you tag yourself", () => {
    expect(
      assignmentAlert({ task: task({ assignedTo: "owner" }), actor: "owner", names }),
    ).toBeNull();
  });

  it("stays quiet when nobody is tagged", () => {
    expect(assignmentAlert({ task: task(), actor: "owner", names })).toBeNull();
  });

  it("stays quiet when the assignee did not change", () => {
    expect(
      assignmentAlert({
        task: task({ assignedTo: "partner" }),
        actor: "owner",
        previous: "partner",
        names,
      }),
    ).toBeNull();
  });

  it("alerts again when a task moves from one person to the other", () => {
    const alert = assignmentAlert({
      task: task({ assignedTo: "partner" }),
      actor: "owner",
      previous: "owner",
      names,
    });
    expect(alert?.to).toBe("partner");
  });

  it("never leaves the shared list", () => {
    expect(
      assignmentAlert({
        task: task({ space: "personal", assignedTo: "partner" }),
        actor: "owner",
        names,
      }),
    ).toBeNull();
  });

  it("tags the notification per task so repeats replace rather than stack", () => {
    const alert = assignmentAlert({
      task: task({ id: "abc", assignedTo: "partner" }),
      actor: "owner",
      names,
    });
    expect(alert?.tag).toBe("joint-assign-abc");
  });

  it("falls back when a name has not been filled in", () => {
    expect(nameFor("owner", { owner: "  ", partner: "Maya" })).toBe("Someone");
    expect(nameFor("partner", { owner: "Sam", partner: "" })).toBe("Your partner");
  });

  it("truncates a very long title rather than shipping an essay to the lock screen", () => {
    const alert = assignmentAlert({
      task: task({ assignedTo: "partner", title: "x".repeat(300) }),
      actor: "owner",
      names,
    });
    expect(alert?.body.length).toBe(120);
  });
});
