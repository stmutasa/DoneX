import { describe, expect, it } from "vitest";
import { buildFeedbackDigest, parseTriageDecision } from "@/lib/ai/generate";
import type { TriageFeedback } from "@/lib/types";
import { distanceLabel, haversineKm, mapLimit } from "@/lib/utils";

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
    expect(parsed.task?.priority).toBe(0);
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
