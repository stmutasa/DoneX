import { describe, expect, it } from "vitest";
import { daysUntil, deadlineLabel, diffDayKeys, effectivePriority, isEscalated } from "@/lib/deadline";
import { isoFromLocal } from "@/lib/utils";

const TZ = "America/New_York";

// Fixed "now": Wednesday 2026-08-12, 10:00 EDT
const NOW = new Date(isoFromLocal("2026-08-12", "10:00", TZ));
const dueOn = (dateKey: string) => isoFromLocal(dateKey, "00:00", TZ);

describe("diffDayKeys / daysUntil", () => {
  it("counts whole days between date keys", () => {
    expect(diffDayKeys("2026-08-12", "2026-08-15")).toBe(3);
    expect(diffDayKeys("2026-08-12", "2026-08-12")).toBe(0);
    expect(diffDayKeys("2026-08-12", "2026-08-10")).toBe(-2);
    expect(diffDayKeys("2026-12-30", "2027-01-02")).toBe(3); // across new year
  });

  it("measures in the user's local days, not UTC", () => {
    // 11pm Tuesday EDT is already Wednesday in UTC — must still count as Tuesday
    const lateNight = new Date(isoFromLocal("2026-08-11", "23:00", TZ));
    expect(daysUntil(dueOn("2026-08-12"), TZ, lateNight)).toBe(1);
  });
});

describe("effectivePriority", () => {
  const byTask = (dateKey: string, priority: 0 | 1 | 2 | 3 = 0) => ({
    priority,
    dueAt: dueOn(dateKey),
    dueKind: "by" as const,
  });

  it("escalates a deadline as the date approaches", () => {
    expect(effectivePriority(byTask("2026-08-20"), TZ, NOW)).toBe(0); // 8d out
    expect(effectivePriority(byTask("2026-08-16"), TZ, NOW)).toBe(1); // 4d out
    expect(effectivePriority(byTask("2026-08-14"), TZ, NOW)).toBe(2); // 2d out
    expect(effectivePriority(byTask("2026-08-13"), TZ, NOW)).toBe(3); // tomorrow
    expect(effectivePriority(byTask("2026-08-12"), TZ, NOW)).toBe(3); // today
    expect(effectivePriority(byTask("2026-08-10"), TZ, NOW)).toBe(3); // past
  });

  it("never lowers a priority the user set higher", () => {
    expect(effectivePriority(byTask("2026-08-16", 3), TZ, NOW)).toBe(3);
    expect(effectivePriority(byTask("2026-08-20", 2), TZ, NOW)).toBe(2);
  });

  it("leaves 'on' tasks and undated tasks alone", () => {
    expect(
      effectivePriority({ priority: 1, dueAt: dueOn("2026-08-13"), dueKind: "on" }, TZ, NOW),
    ).toBe(1);
    expect(effectivePriority({ priority: 2, dueAt: null, dueKind: "by" }, TZ, NOW)).toBe(2);
  });

  it("reports escalation only when the boost is active", () => {
    expect(isEscalated(byTask("2026-08-13", 0), TZ, NOW)).toBe(true);
    expect(isEscalated(byTask("2026-08-20", 0), TZ, NOW)).toBe(false);
    expect(isEscalated(byTask("2026-08-13", 3), TZ, NOW)).toBe(false); // already P1
  });
});

describe("deadlineLabel", () => {
  it("names the near-term days", () => {
    expect(deadlineLabel(dueOn("2026-08-12"), TZ, NOW)).toBe("by today");
    expect(deadlineLabel(dueOn("2026-08-13"), TZ, NOW)).toBe("by tomorrow");
    expect(deadlineLabel(dueOn("2026-08-15"), TZ, NOW)).toBe("by Sat · 3d left");
  });

  it("uses a calendar date a week or more out", () => {
    expect(deadlineLabel(dueOn("2026-08-24"), TZ, NOW)).toBe("by Aug 24 · 12d left");
  });

  it("flags missed deadlines", () => {
    expect(deadlineLabel(dueOn("2026-08-11"), TZ, NOW)).toBe("by yesterday · overdue");
    expect(deadlineLabel(dueOn("2026-08-09"), TZ, NOW)).toBe("overdue 3d");
  });
});
