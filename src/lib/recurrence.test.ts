import { describe, expect, it } from "vitest";
import { describeRecurrence, nextOccurrence } from "@/lib/recurrence";
import { isoFromLocal, localTimeKey } from "@/lib/utils";

const TZ = "America/New_York";

function iso(dateLocal: string, time: string): string {
  return isoFromLocal(dateLocal, time, TZ);
}

describe("nextOccurrence", () => {
  it("advances daily by the given interval", () => {
    const from = new Date(iso("2026-01-05", "09:30")); // Monday
    const next = nextOccurrence({ freq: "daily", interval: 3 }, from, TZ);
    expect(next.toISOString()).toBe(new Date(iso("2026-01-08", "09:30")).toISOString());
  });

  it("weekly byWeekday walks forward across a week boundary", () => {
    // Wed Jan 7 2026, pattern Mon+Wed: next hit is the following Monday, not
    // the same week — crosses from the week of Jan 4 into the week of Jan 11.
    const from = new Date(iso("2026-01-07", "09:00")); // Wednesday
    const next = nextOccurrence({ freq: "weekly", byWeekday: [1, 3] }, from, TZ);
    expect(next.toISOString()).toBe(new Date(iso("2026-01-12", "09:00")).toISOString());
  });

  it("weekly with interval=2 skips the off week", () => {
    // Mon Jan 5 2026 is itself a Monday; "every other Monday" should land on
    // Jan 19 (skipping Jan 12, the off-cycle week).
    const from = new Date(iso("2026-01-05", "09:00")); // Monday
    const next = nextOccurrence({ freq: "weekly", byWeekday: [1], interval: 2 }, from, TZ);
    expect(next.toISOString()).toBe(new Date(iso("2026-01-19", "09:00")).toISOString());
  });

  it("weekly with no byWeekday just adds interval*7 days", () => {
    const from = new Date(iso("2026-01-05", "09:00"));
    const next = nextOccurrence({ freq: "weekly", interval: 2 }, from, TZ);
    expect(next.toISOString()).toBe(new Date(iso("2026-01-19", "09:00")).toISOString());
  });

  it("monthly byMonthDay=31 clamps to the last day of a short month", () => {
    const from = new Date(iso("2026-01-31", "10:00")); // Saturday
    const next = nextOccurrence({ freq: "monthly", byMonthDay: 31 }, from, TZ);
    // 2026 is not a leap year: Feb has 28 days.
    expect(next.toISOString()).toBe(new Date(iso("2026-02-28", "10:00")).toISOString());
  });

  it("yearly advances by the given interval", () => {
    const from = new Date(iso("2026-06-15", "08:00"));
    const next = nextOccurrence({ freq: "yearly", interval: 2 }, from, TZ);
    expect(next.toISOString()).toBe(new Date(iso("2028-06-15", "08:00")).toISOString());
  });

  it("preserves the exact local time-of-day", () => {
    const from = new Date(iso("2026-01-15", "14:45"));
    const next = nextOccurrence({ freq: "monthly" }, from, TZ);
    expect(localTimeKey(next, TZ)).toBe("14:45");
    expect(next.toISOString()).toBe(new Date(iso("2026-02-15", "14:45")).toISOString());
  });

  it("stays stable across a DST spring-forward transition", () => {
    // Sat Mar 7 2026 09:00 ET (EST, UTC-5) + 2 days lands after the Mar 8
    // spring-forward, so the UTC instant shifts by 47h, not a naive 48h —
    // but the local wall-clock time-of-day is unchanged.
    const from = new Date(iso("2026-03-07", "09:00"));
    const next = nextOccurrence({ freq: "daily", interval: 2 }, from, TZ);
    expect(next.toISOString()).toBe(new Date(iso("2026-03-09", "09:00")).toISOString());
    expect(localTimeKey(next, TZ)).toBe("09:00");
    const naive48h = new Date(from.getTime() + 48 * 3600_000);
    expect(next.toISOString()).not.toBe(naive48h.toISOString());
  });
});

describe("describeRecurrence", () => {
  it("describes null as empty", () => {
    expect(describeRecurrence(null)).toBe("");
  });

  it("describes daily rules", () => {
    expect(describeRecurrence({ freq: "daily" })).toBe("Every day");
    expect(describeRecurrence({ freq: "daily", interval: 3 })).toBe("Every 3 days");
  });

  it("describes weekly rules with weekday names", () => {
    expect(describeRecurrence({ freq: "weekly", byWeekday: [0, 3] })).toBe("Every week on Sun, Wed");
    expect(describeRecurrence({ freq: "weekly", interval: 2 })).toBe("Every 2 weeks");
  });

  it("describes monthly rules", () => {
    expect(describeRecurrence({ freq: "monthly", byMonthDay: 1 })).toBe("Every month on day 1");
    expect(describeRecurrence({ freq: "monthly" })).toBe("Every month");
  });

  it("describes yearly rules", () => {
    expect(describeRecurrence({ freq: "yearly" })).toBe("Every year");
  });
});
