import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TriageFeedback } from "@/lib/types";
import type { CompleteArgs, ProviderAdapter, ProviderConfig } from "@/lib/ai/provider";
import { distanceLabel, haversineKm, isQuietTime, mapLimit } from "@/lib/utils";

// A throwaway data directory per run, so the real one is never touched.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "donex-triage-"));
process.env.DATA_DIR = DIR;

// The model, scripted: each test says what it answers, and every request is
// kept so the prompt's shape can be checked.
const model = vi.hoisted(() => ({
  answer: (_args: CompleteArgs): string | Promise<string> => "{}",
  calls: [] as CompleteArgs[],
}));

vi.mock("@/lib/ai/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/adapters")>();
  const cfg: ProviderConfig = { kind: "openai", baseUrl: "", apiKey: "test", model: "test" };
  const adapter: ProviderAdapter = {
    complete: async (args) => {
      model.calls.push(args);
      return model.answer(args);
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

const {
  appendUpdateNote,
  buildFeedbackDigest,
  findUpdateTarget,
  parseLocalDue,
  parseTriageDecision,
  sweepAutoDismissable,
  triageInboxItem,
} = await import("@/lib/ai/generate");
const { inboxRepo, settingsRepo, tasksRepo } = await import("@/lib/db/repos");

beforeAll(() => {
  settingsRepo.updateApp({ tz: "America/New_York" });
});

afterAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("buildFeedbackDigest", () => {
  const lesson = (kind: TriageFeedback["kind"], reason: string): TriageFeedback => ({
    id: reason,
    kind,
    reason,
    content: "Some email content that goes on for a while",
    fromLabel: "Sender",
    source: "gmail",
    createdAt: "2026-08-11T12:00:00Z",
  });

  it("returns empty string with no lessons", () => {
    expect(buildFeedbackDigest([])).toBe("");
  });

  it("splits keep and dismiss lessons into labelled sections", () => {
    const digest = buildFeedbackDigest([
      lesson("should_have_kept", "school emails matter"),
      lesson("dismiss_because", "never care about LinkedIn"),
    ]);
    expect(digest).toContain("KEPT");
    expect(digest).toContain("school emails matter");
    expect(digest).toContain("Lean dismiss");
    expect(digest).toContain("never care about LinkedIn");
  });

  it("caps each side at the given limit", () => {
    const many = Array.from({ length: 12 }, (_, i) => lesson("dismiss_because", `reason ${i}`));
    const digest = buildFeedbackDigest(many, 3);
    expect(digest).toContain("reason 0");
    expect(digest).toContain("reason 2");
    expect(digest).not.toContain("reason 3");
  });
});

describe("isQuietTime", () => {
  it("handles a window wrapping past midnight", () => {
    expect(isQuietTime("23:30", "22:00", "06:00")).toBe(true);
    expect(isQuietTime("02:00", "22:00", "06:00")).toBe(true);
    expect(isQuietTime("06:00", "22:00", "06:00")).toBe(false); // end exclusive
    expect(isQuietTime("21:59", "22:00", "06:00")).toBe(false);
    expect(isQuietTime("22:00", "22:00", "06:00")).toBe(true); // start inclusive
    expect(isQuietTime("12:00", "22:00", "06:00")).toBe(false);
  });

  it("handles a same-day window and unpadded times", () => {
    expect(isQuietTime("13:00", "9:00", "17:00")).toBe(true);
    expect(isQuietTime("08:59", "9:00", "17:00")).toBe(false);
    expect(isQuietTime("17:00", "9:00", "17:00")).toBe(false);
  });

  it("never quiet when start equals end", () => {
    expect(isQuietTime("22:00", "22:00", "22:00")).toBe(false);
  });
});

describe("haversineKm / distanceLabel", () => {
  it("computes a known distance (NYC → Philadelphia ≈ 130km)", () => {
    const km = haversineKm({ lat: 40.7128, lng: -74.006 }, { lat: 39.9526, lng: -75.1652 });
    expect(km).toBeGreaterThan(120);
    expect(km).toBeLessThan(140);
  });

  it("is zero for identical points", () => {
    expect(haversineKm({ lat: 40, lng: -74 }, { lat: 40, lng: -74 })).toBe(0);
  });

  it("labels short distances in feet and longer in miles", () => {
    expect(distanceLabel(0.05)).toMatch(/ft$/);
    expect(distanceLabel(0.8)).toBe("0.5 mi");
    expect(distanceLabel(20)).toMatch(/^\d+ mi$/);
  });
});

describe("parseTriageDecision", () => {
  it("normalizes a full task decision", () => {
    const parsed = parseTriageDecision(
      {
        decision: "task",
        reason: "Dentist wants confirmation",
        task: {
          title: "Confirm dental cleaning",
          dueAtLocal: "2026-08-12 15:00",
          priority: 2,
          projectName: "Health",
          tags: ["#Phone", "appointments", "HEALTH", "extra"],
        },
      },
      "fallback",
    );
    expect(parsed.decision).toBe("task");
    expect(parsed.task).toMatchObject({
      title: "Confirm dental cleaning",
      dueAtLocal: "2026-08-12 15:00",
      priority: 2,
      projectName: "Health",
    });
    // normalized: # stripped, lowercased, capped at 3
    expect(parsed.task?.tags).toEqual(["phone", "appointments", "health"]);
  });

  it("normalizes an update decision with partial fields", () => {
    const parsed = parseTriageDecision(
      {
        decision: "update",
        reason: "Appointment moved",
        update: { taskTitle: "Call the dentist about Tuesday", dueAtLocal: "2026-08-14 16:00", priority: null, note: "Moved from Tue 3pm to Fri 4pm per office email" },
      },
      "x",
    );
    expect(parsed.decision).toBe("update");
    expect(parsed.update).toMatchObject({
      taskTitle: "Call the dentist about Tuesday",
      dueAtLocal: "2026-08-14 16:00",
      priority: null,
    });
    expect(parsed.update?.note).toContain("Moved from Tue");
    expect(parsed.task).toBeNull();
  });

  it("clamps update priority when provided", () => {
    const parsed = parseTriageDecision(
      { decision: "update", update: { taskTitle: "T", priority: 7 } },
      "x",
    );
    expect(parsed.update?.priority).toBe(3);
  });

  it("maps duplicate with its target title", () => {
    const parsed = parseTriageDecision(
      { decision: "duplicate", duplicateOf: "Call the dentist about Tuesday", reason: "covered" },
      "x",
    );
    expect(parsed.decision).toBe("duplicate");
    expect(parsed.duplicateOf).toBe("Call the dentist about Tuesday");
    expect(parsed.task).toBeNull();
  });

  it("maps dismiss, and legacy ignore, to dismiss", () => {
    expect(parseTriageDecision({ decision: "dismiss" }, "x").decision).toBe("dismiss");
    expect(parseTriageDecision({ action: "ignore" }, "x").decision).toBe("dismiss");
  });

  it("falls back to task on unknown decisions, using the item content as title", () => {
    const parsed = parseTriageDecision({ decision: "??", reason: "" }, "Pay the water bill");
    expect(parsed.decision).toBe("task");
    expect(parsed.task?.title).toBe("Pay the water bill");
    // Even a task rescued from a malformed answer gets a real priority.
    expect(parsed.task?.priority).toBe(1);
  });

  it("clamps out-of-range priorities", () => {
    const parsed = parseTriageDecision(
      { decision: "task", task: { title: "T", priority: 9 } },
      "x",
    );
    expect(parsed.task?.priority).toBe(3);
  });
});

describe("mapLimit", () => {
  it("processes every item and preserves order", async () => {
    const seen: number[] = [];
    const results = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      seen.push(n);
      return n * 10;
    });
    expect(results.map((r) => (r.status === "fulfilled" ? r.value : -1))).toEqual([
      10, 20, 30, 40, 50,
    ]);
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("captures rejections without failing the batch", async () => {
    const results = await mapLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(results[2].status).toBe("fulfilled");
  });

  it("never runs more than the limit concurrently", async () => {
    let active = 0;
    let peak = 0;
    await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("parseTriageDecision — deadline and priority", () => {
  const task = (over: Record<string, unknown>) =>
    parseTriageDecision({ decision: "task", reason: "r", task: { title: "Do it", ...over } }, "x").task!;

  it("reads where the date came from and why", () => {
    const t = task({ dueAtLocal: "2026-10-08", deadlineBasis: "inferred", deadlineWhy: "someone is waiting" });
    expect(t.deadlineBasis).toBe("inferred");
    expect(t.deadlineWhy).toBe("someone is waiting");
  });

  it("believes a stated date only when told so", () => {
    expect(task({ dueAtLocal: "2026-10-08", deadlineBasis: "stated" }).deadlineBasis).toBe("stated");
    expect(task({ dueAtLocal: "2026-10-08" }).deadlineBasis).toBe("inferred");
  });

  it("never lets a task through at priority 'none'", () => {
    expect(task({ priority: 0 }).priority).toBe(1);
    expect(task({}).priority).toBe(1);
    expect(task({ priority: 3 }).priority).toBe(3);
  });

  it("leaves an update's priority alone, since 'no change' is a real answer there", () => {
    const parsed = parseTriageDecision(
      { decision: "update", reason: "r", update: { taskTitle: "T", priority: null } },
      "x",
    );
    expect(parsed.update?.priority).toBeNull();
  });
});

describe("appendUpdateNote", () => {
  it("keeps the user's existing notes whole, however long", () => {
    const existing = "x".repeat(3000);
    const out = appendUpdateNote(existing, "Moved to Thursday 10am", "2026-10-27");
    expect(out.startsWith(existing)).toBe(true);
    expect(out.endsWith("Update (2026-10-27): Moved to Thursday 10am")).toBe(true);
  });

  it("caps only the new stamp", () => {
    const out = appendUpdateNote("mine", "y".repeat(1000), "2026-10-27");
    expect(out.startsWith("mine\n\n")).toBe(true);
    expect(out.length).toBeLessThanOrEqual("mine\n\n".length + 300);
  });

  it("starts the notes when there were none", () => {
    expect(appendUpdateNote("  ", "New detail", "2026-10-27")).toBe("Update (2026-10-27): New detail");
  });
});

describe("findUpdateTarget", () => {
  const t = (id: string, title: string) => ({ id, title }) as unknown as import("@/lib/types").Task;

  it("prefers an exact title, then forgives case, quotes, spacing and a full stop", () => {
    const tasks = [t("a", "Call the dentist"), t("b", "Dentist appointment Tue 3pm")];
    expect(findUpdateTarget("call the dentist", tasks)?.id).toBe("a");
    expect(findUpdateTarget("“Dentist  appointment Tue 3pm”.", tasks)?.id).toBe("b");
    expect(findUpdateTarget("Dentist appointment", tasks)).toBeNull();
    expect(findUpdateTarget("", tasks)).toBeNull();
  });

  it("takes the first list's task when two lists share a title", () => {
    const tasks = [t("personal", "Pay rent"), t("joint", "Pay rent")];
    expect(findUpdateTarget("Pay rent", tasks)?.id).toBe("personal");
  });
});

describe("parseLocalDue", () => {
  const tz = "America/New_York";

  it("reads 12-hour times instead of dropping the pm", () => {
    expect(parseLocalDue("2026-10-30 5:00 PM", tz)).toEqual({ dueAt: "2026-10-30T21:00:00.000Z", allDay: false });
    expect(parseLocalDue("2026-10-30 5pm", tz)).toEqual({ dueAt: "2026-10-30T21:00:00.000Z", allDay: false });
    expect(parseLocalDue("2026-10-30T17:00", tz)).toEqual({ dueAt: "2026-10-30T21:00:00.000Z", allDay: false });
  });

  it("keeps the date when what follows is not a time", () => {
    expect(parseLocalDue("2026-10-30 EOD", tz)).toEqual({ dueAt: "2026-10-30T04:00:00.000Z", allDay: true });
    expect(parseLocalDue("2026-10-30", tz)).toEqual({ dueAt: "2026-10-30T04:00:00.000Z", allDay: true });
  });

  it("treats empty and null-ish answers as no date", () => {
    expect(parseLocalDue("", tz)).toEqual({ dueAt: null, allDay: false });
    expect(parseLocalDue("null", tz)).toEqual({ dueAt: null, allDay: false });
    expect(parseLocalDue(undefined, tz)).toEqual({ dueAt: null, allDay: false });
  });
});

describe("triageInboxItem", () => {
  let seq = 0;
  const email = (content: string) =>
    inboxRepo.create({ source: "gmail", externalId: `msg-${++seq}`, fromLabel: "Office", content })!;
  const answer = (payload: Record<string, unknown>) => {
    model.answer = () => JSON.stringify(payload);
  };

  beforeEach(() => {
    model.calls = [];
    model.answer = () => "{}";
  });

  it("sends the rules and the user's context as cacheable shared segments, the item last", async () => {
    tasksRepo.create({ title: "Renew the parking permit" });
    const item = email("Your order has shipped");
    answer({ decision: "dismiss", reason: "Shipping notice" });
    await triageInboxItem(item.id);

    expect(model.calls).toHaveLength(1);
    const [call] = model.calls;
    expect(call.shared).toHaveLength(2);
    expect(call.shared![0]).toContain("Return JSON exactly like");
    expect(call.shared![1]).toContain("Renew the parking permit");
    expect(call.shared!.join("\n")).not.toContain("Your order has shipped");
    expect(call.prompt).toContain("Your order has shipped");
    expect(call.prompt).not.toContain("Return JSON exactly like");
  });

  it("updates a joint-list task the prompt showed the model", async () => {
    const joint = tasksRepo.create({ title: "Dentist appointment Tue 3pm", space: "joint" });
    const item = email("Your appointment has moved to Thursday at 10am.");
    answer({
      decision: "update",
      reason: "Appointment moved",
      update: { taskTitle: "Dentist appointment Tue 3pm", dueAtLocal: null, priority: null, note: "Moved to Thu 10am" },
    });
    const out = await triageInboxItem(item.id);

    expect(out.status).toBe("resolved");
    expect(out.resolvedTaskId).toBe(joint.id);
    expect(tasksRepo.get(joint.id)?.notes).toContain("Moved to Thu 10am");
  });

  it("appends an update without cutting the task's long notes", async () => {
    const long = "n".repeat(3000);
    const task = tasksRepo.create({ title: "Plan the kitchen refit", notes: long });
    const item = email("The cabinets arrive on the 12th.");
    answer({
      decision: "update",
      update: { taskTitle: "Plan the kitchen refit", dueAtLocal: null, priority: null, note: "Cabinets arrive on the 12th" },
    });
    await triageInboxItem(item.id);

    const notes = tasksRepo.get(task.id)!.notes;
    expect(notes.startsWith(long)).toBe(true);
    expect(notes).toContain("Cabinets arrive on the 12th");
  });

  it("keeps an update it can't match in the inbox, out of the sweep's reach", async () => {
    const item = email("Your table for Friday is now at 8pm.");
    answer({
      decision: "update",
      update: { taskTitle: "Dinner reservation", dueAtLocal: "2026-11-06 8:00 PM", priority: null, note: "Now 8pm" },
    });
    const out = await triageInboxItem(item.id);

    expect(out.status).toBe("new");
    expect(out.suggestion?.action).toBe("task");
    expect(out.suggestion?.reason).toContain("no open task matches");
    expect(out.suggestion?.task?.title).toBe("Dinner reservation");
    expect(out.suggestion?.task?.dueAt).toBe("2026-11-07T01:00:00.000Z");

    sweepAutoDismissable();
    expect(inboxRepo.get(item.id)?.status).toBe("new");
  });

  it("leaves the user's own resolution alone when the verdict lands after it", async () => {
    const task = tasksRepo.create({ title: "Reply to the school" });
    const item = email("Please confirm the trip form by Friday.");
    model.answer = () => {
      // The user taps "Add as task" while the model is still thinking.
      inboxRepo.resolve(item.id, "resolved", task.id);
      return JSON.stringify({ decision: "dismiss", reason: "FYI" });
    };
    const out = await triageInboxItem(item.id);

    expect(out.status).toBe("resolved");
    expect(out.resolvedTaskId).toBe(task.id);
    expect(inboxRepo.get(item.id)?.suggestion).toBeNull();
  });

  it("applies an update once when two runs triage the same item together", async () => {
    const task = tasksRepo.create({ title: "Book the plumber" });
    const item = email("The plumber can come Wednesday morning instead.");
    model.answer = async () => {
      await new Promise((r) => setTimeout(r, 5));
      return JSON.stringify({
        decision: "update",
        update: { taskTitle: "Book the plumber", dueAtLocal: null, priority: null, note: "Wednesday morning works" },
      });
    };
    await Promise.all([triageInboxItem(item.id), triageInboxItem(item.id)]);

    expect(model.calls).toHaveLength(1);
    const notes = tasksRepo.get(task.id)!.notes;
    expect(notes.match(/Wednesday morning works/g)).toHaveLength(1);
    expect(inboxRepo.get(item.id)?.status).toBe("resolved");
  });

  it("doesn't pay to triage an item that already has a verdict", async () => {
    const item = email("Can you send the signed lease back by the 14th?");
    answer({ decision: "task", reason: "Lease to sign", task: { title: "Send back the signed lease", dueAtLocal: "2026-11-14", deadlineBasis: "stated", priority: 2 } });
    const first = await triageInboxItem(item.id);
    expect(first.suggestion?.action).toBe("task");

    // A run that lags behind reaches the same item with a different answer.
    model.calls = [];
    answer({ decision: "dismiss", reason: "Nothing to do" });
    const again = await triageInboxItem(item.id);

    expect(model.calls).toHaveLength(0);
    expect(again.status).toBe("new");
    expect(again.suggestion).toEqual(first.suggestion);
  });

  it("gives an unmatched update a real deadline and priority, like any triaged task", async () => {
    const item = email("Quick note: the carpool rota changed.");
    answer({ decision: "update", update: { taskTitle: "Carpool rota", dueAtLocal: null, priority: null, note: "Rota changed" } });
    const out = await triageInboxItem(item.id);

    expect(out.suggestion?.action).toBe("task");
    expect(out.suggestion?.task?.dueAt).toBeTruthy();
    expect(out.suggestion?.task?.dueKind).toBe("by");
    expect(out.suggestion?.task?.priority).toBe(1);
    expect(out.suggestion?.dueSuggested).toBe(true);
    expect(out.suggestion?.dueWhy).toBeTruthy();
  });
});
