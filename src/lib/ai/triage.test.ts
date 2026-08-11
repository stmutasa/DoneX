import { describe, expect, it } from "vitest";
import { parseTriageDecision } from "@/lib/ai/generate";
import { mapLimit } from "@/lib/utils";

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
