import { describe, expect, it } from "vitest";
import type { RecurrenceRule } from "@/lib/types";

// The server runs in UTC, and the every-N-weeks bug only shows when the
// process zone differs from the user's, so pin it before loading the code.
process.env.TZ = "UTC";
const { anchorRule, describeRecurrence, nextOccurrence } = await import("@/lib/recurrence");
const { isoFromLocal, localDateKey, localTimeKey } = await import("@/lib/utils");

const TZ = "America/New_York";

function iso(dateLocal: string, time: string): string {
  return isoFromLocal(dateLocal, time, TZ);
}

describe("quarterly repeats", () => {
  it("lands three months on, keeping the day", () => {
    const next = nextOccurrence({ freq: "monthly", interval: 3, byMonthDay: 15 }, new Date("2026-01-15T09:00:00"), "America/New_York");
    expect(next.getMonth()).toBe(3); // April
    expect(next.getDate()).toBe(15);
  });

  it("is described as quarterly rather than 'every 3 months'", () => {
    expect(describeRecurrence({ freq: "monthly", interval: 3 })).toBe("Quarterly");
    expect(describeRecurrence({ freq: "monthly", interval: 3, byMonthDay: 15 })).toBe(
      "Quarterly on day 15",
    );
    expect(describeRecurrence({ freq: "monthly", interval: 4 })).toBe("Every 4 months");
  });
});

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

/** Follow a rule for `count` steps and return each local date. */
function series(rule: RecurrenceRule, fromIso: string, count: number, tz = TZ): string[] {
  const out: string[] = [];
  let at = new Date(fromIso);
  for (let i = 0; i < count; i++) {
    at = nextOccurrence(rule, at, tz);
    out.push(localDateKey(at, tz));
  }
  return out;
}

describe("monthly and yearly anchor day", () => {
  it("returns to the 31st after a 30-day month", () => {
    const rule: RecurrenceRule = { freq: "monthly", byMonthDay: 31 };
    expect(series(rule, iso("2026-03-31", "09:00"), 3)).toEqual(["2026-04-30", "2026-05-31", "2026-06-30"]);
  });

  it("returns to the 31st after February", () => {
    const rule = anchorRule({ freq: "monthly" }, new Date(iso("2026-01-31", "09:00")), TZ);
    expect(rule).toEqual({ freq: "monthly", byMonthDay: 31 });
    expect(series(rule, iso("2026-01-31", "09:00"), 4)).toEqual([
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
    ]);
  });

  it("keeps a quarterly rule on the anchor day", () => {
    const rule = anchorRule({ freq: "monthly", interval: 3 }, new Date(iso("2026-01-31", "09:00")), TZ);
    expect(series(rule, iso("2026-01-31", "09:00"), 3)).toEqual(["2026-04-30", "2026-07-31", "2026-10-31"]);
  });

  it("keeps the time of day while it clamps", () => {
    const rule: RecurrenceRule = { freq: "monthly", byMonthDay: 31 };
    const next = nextOccurrence(rule, new Date(iso("2026-02-28", "21:15")), TZ);
    expect(next.toISOString()).toBe(new Date(iso("2026-03-31", "21:15")).toISOString());
  });

  it("brings a Feb 29 yearly rule back to the 29th in the next leap year", () => {
    const rule = anchorRule({ freq: "yearly" }, new Date(iso("2028-02-29", "08:00")), TZ);
    expect(rule).toEqual({ freq: "yearly", byMonthDay: 29 });
    expect(series(rule, iso("2028-02-29", "08:00"), 4)).toEqual([
      "2029-02-28",
      "2030-02-28",
      "2031-02-28",
      "2032-02-29",
    ]);
  });

  it("lets a yearly date moved by hand win over a stale stored day", () => {
    const rule: RecurrenceRule = { freq: "yearly", byMonthDay: 29 };
    expect(series(rule, iso("2027-03-05", "08:00"), 1)).toEqual(["2028-03-05"]);
    expect(anchorRule(rule, new Date(iso("2027-03-05", "08:00")), TZ)).toEqual({
      freq: "yearly",
      byMonthDay: 5,
    });
  });

  it("treats only a stored 29 as clamped onto Feb 28", () => {
    // A day of 31 on Feb 28 means the date was moved there by hand.
    const moved: RecurrenceRule = { freq: "yearly", byMonthDay: 31 };
    expect(series(moved, iso("2027-02-28", "08:00"), 2)).toEqual(["2028-02-28", "2029-02-28"]);
    expect(anchorRule(moved, new Date(iso("2027-02-28", "08:00")), TZ).byMonthDay).toBe(28);
    // Feb 28 in a leap year is a real choice too, not a clamp.
    const leap: RecurrenceRule = { freq: "yearly", byMonthDay: 29 };
    expect(series(leap, iso("2028-02-28", "08:00"), 1)).toEqual(["2029-02-28"]);
  });

  it("reads the anchor day in the user's zone", () => {
    // 11:30 PM on Jan 31 in New York is already Feb 1 in UTC.
    const rule = anchorRule({ freq: "monthly" }, new Date(iso("2026-01-31", "23:30")), TZ);
    expect(rule.byMonthDay).toBe(31);
  });

  it("leaves rules with nothing to pin untouched", () => {
    const from = new Date(iso("2026-01-31", "09:00"));
    const daily: RecurrenceRule = { freq: "daily" };
    const weekly: RecurrenceRule = { freq: "weekly", byWeekday: [1] };
    const monthly: RecurrenceRule = { freq: "monthly", byMonthDay: 15 };
    const yearly: RecurrenceRule = { freq: "yearly", byMonthDay: 31 };
    expect(anchorRule(daily, from, TZ)).toBe(daily);
    expect(anchorRule(weekly, from, TZ)).toBe(weekly);
    expect(anchorRule(monthly, from, TZ)).toBe(monthly);
    expect(anchorRule(yearly, from, TZ)).toBe(yearly);
  });
});

describe("every-N-weeks rules count weeks in the user's zone", () => {
  // The server runs in UTC. These evening times fall on the next UTC day.
  it("skips the off week for a Saturday evening start", () => {
    const rule: RecurrenceRule = { freq: "weekly", interval: 2, byWeekday: [0, 6] };
    const next = nextOccurrence(rule, new Date(iso("2026-10-24", "21:00")), TZ);
    expect(next.toISOString()).toBe(new Date(iso("2026-11-01", "21:00")).toISOString());
  });

  it("keeps a two-week gap across the end of DST", () => {
    const rule: RecurrenceRule = { freq: "weekly", interval: 2, byWeekday: [6] };
    const next = nextOccurrence(rule, new Date(iso("2026-10-24", "19:30")), TZ);
    expect(next.toISOString()).toBe(new Date(iso("2026-11-07", "19:30")).toISOString());
  });

  it("keeps a two-week gap across the start of DST", () => {
    const rule: RecurrenceRule = { freq: "weekly", interval: 2, byWeekday: [6] };
    const next = nextOccurrence(rule, new Date(iso("2026-03-07", "19:30")), TZ);
    expect(next.toISOString()).toBe(new Date(iso("2026-03-21", "19:30")).toISOString());
  });

  it("stays in the on week for the next day", () => {
    const rule: RecurrenceRule = { freq: "weekly", interval: 2, byWeekday: [5, 6] };
    expect(series(rule, iso("2026-10-02", "21:00"), 4)).toEqual([
      "2026-10-03",
      "2026-10-16",
      "2026-10-17",
      "2026-10-30",
    ]);
  });

  it("works for zones ahead of UTC", () => {
    // 8 AM Sunday in Tokyo is still Saturday in UTC.
    const tokyo = "Asia/Tokyo";
    const rule: RecurrenceRule = { freq: "weekly", interval: 2, byWeekday: [0, 1] };
    const from = new Date(isoFromLocal("2026-10-25", "08:00", tokyo));
    const next = nextOccurrence(rule, from, tokyo);
    expect(next.toISOString()).toBe(new Date(isoFromLocal("2026-10-26", "08:00", tokyo)).toISOString());
    expect(series(rule, from.toISOString(), 3, tokyo)).toEqual(["2026-10-26", "2026-11-08", "2026-11-09"]);
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
