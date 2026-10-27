import { describe, expect, it } from "vitest";
import {
  reviewIsStale,
  reviewedWeek,
  weekEndKey,
  weekKeyOfDay,
  weekRange,
} from "@/lib/reviewWeek";

describe("weekKeyOfDay", () => {
  it("names the ISO week a local day falls in", () => {
    expect(weekKeyOfDay("2026-10-25")).toBe("2026-W43"); // a Sunday ends its week
    expect(weekKeyOfDay("2026-10-26")).toBe("2026-W44"); // Monday starts the next
    expect(weekKeyOfDay("2027-01-03")).toBe("2026-W53");
  });
});

describe("reviewedWeek", () => {
  it("reviews the week ending today on a Sunday", () => {
    expect(reviewedWeek("2026-10-25")).toEqual({
      weekKey: "2026-W43",
      from: "2026-10-19",
      to: "2026-10-25",
    });
  });

  it("reviews the week just gone on any other day, not the one just begun", () => {
    expect(reviewedWeek("2026-10-26").weekKey).toBe("2026-W43"); // Monday
    expect(reviewedWeek("2026-10-31").weekKey).toBe("2026-W43"); // Saturday
    expect(reviewedWeek("2026-10-26").to).toBe("2026-10-25");
  });
});

describe("weekEndKey", () => {
  it("finds the Sunday that closes a week, across a year end", () => {
    expect(weekEndKey("2026-W43")).toBe("2026-10-25");
    expect(weekEndKey("2026-W53")).toBe("2027-01-03");
    expect(weekEndKey("2027-W01")).toBe("2027-01-10");
    expect(weekEndKey("nonsense")).toBeNull();
  });
});

describe("weekRange", () => {
  it("gives Monday to Sunday", () => {
    expect(weekRange("2026-W44")).toEqual({ from: "2026-10-26", to: "2026-11-01" });
    expect(weekRange("2026-W53")).toEqual({ from: "2026-12-28", to: "2027-01-03" });
  });
});

describe("reviewIsStale", () => {
  const TZ = "America/New_York";
  const stale = (over: Partial<Parameters<typeof reviewIsStale>[0]>, now = 3) =>
    reviewIsStale({
      generatedAt: "2026-10-26T13:00:00Z", // Monday morning
      completedCount: 3,
      weekKey: "2026-W44",
      todayKey: "2026-10-28",
      tz: TZ,
      completedNow: () => now,
      ...over,
    });

  it("leaves a mid-week review alone while nothing new has been completed", () => {
    expect(stale({}, 3)).toBe(false);
  });

  it("redoes a mid-week review on a later day once the week has moved on", () => {
    expect(stale({}, 5)).toBe(true);
  });

  it("never redoes one made earlier the same day", () => {
    expect(stale({ generatedAt: "2026-10-28T13:00:00Z" }, 5)).toBe(false);
  });

  it("keeps the review made on the week's last evening", () => {
    // Sunday 6 PM EDT is 22:00Z; 8:30 PM EDT is already Monday in UTC.
    const done = { weekKey: "2026-W43", todayKey: "2026-10-27" };
    expect(stale({ ...done, generatedAt: "2026-10-25T22:00:00Z" }, 9)).toBe(false);
    expect(stale({ ...done, generatedAt: "2026-10-26T00:30:00Z" }, 9)).toBe(false);
  });

  it("redoes a finished week's review if it was made before the week ended", () => {
    const done = { weekKey: "2026-W43", todayKey: "2026-10-27" };
    expect(stale({ ...done, generatedAt: "2026-10-21T13:00:00Z" }, 3)).toBe(true);
  });

  it("doesn't count completions unless it has to", () => {
    let asked = 0;
    reviewIsStale({
      generatedAt: "2026-10-25T22:00:00Z",
      completedCount: 0,
      weekKey: "2026-W43",
      todayKey: "2026-10-27",
      tz: TZ,
      completedNow: () => ++asked,
    });
    expect(asked).toBe(0);
  });
});
