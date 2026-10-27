import { describe, expect, it } from "vitest";
import {
  calendarDaysUntil,
  dueLabelIn,
  isOverdueIn,
  runtimeZone,
  timeIn,
} from "@/lib/tzLabels";

// vitest runs in UTC here, like the server. The user is in New York.
const TZ = "America/New_York";
const MORNING = new Date("2026-10-27T11:00:00Z"); // Tue 7:00 AM EDT
const EVENING = new Date("2026-10-27T22:00:00Z"); // Tue 6:00 PM EDT

describe("calendarDaysUntil", () => {
  it("counts local days, not 24-hour blocks", () => {
    expect(calendarDaysUntil("2026-10-28T01:00:00Z", TZ, MORNING)).toBe(0); // Tue 9 PM
    expect(calendarDaysUntil("2026-10-28T13:00:00Z", TZ, EVENING)).toBe(1); // Wed 9 AM
    expect(calendarDaysUntil("2026-10-26T23:00:00Z", TZ, EVENING)).toBe(-1); // Mon 7 PM
  });

  it("is still one day across the end of daylight time", () => {
    // Sun Nov 1 noon EDT-turned-EST to Mon Nov 2 noon EST is 25 hours.
    expect(calendarDaysUntil("2026-11-02T17:00:00Z", TZ, new Date("2026-11-01T17:00:00Z"))).toBe(1);
  });
});

describe("timeIn", () => {
  it("reads the user's wall clock", () => {
    expect(timeIn("2026-10-27T22:00:00Z", TZ)).toBe("6:00 PM");
    expect(timeIn("2026-12-01T23:00:00Z", TZ)).toBe("6:00 PM"); // EST
  });
});

describe("isOverdueIn", () => {
  it("lets an all-day task run to local midnight", () => {
    const today = "2026-10-27T04:00:00.000Z"; // Tue, local midnight EDT
    expect(isOverdueIn(today, true, TZ, EVENING)).toBe(false);
    expect(isOverdueIn(today, true, TZ, new Date("2026-10-28T03:59:00Z"))).toBe(false); // 11:59 PM
    expect(isOverdueIn(today, true, TZ, new Date("2026-10-28T04:01:00Z"))).toBe(true);
  });

  it("treats a timed task as late the moment it passes", () => {
    expect(isOverdueIn("2026-10-27T21:59:00Z", false, TZ, EVENING)).toBe(true);
    expect(isOverdueIn("2026-10-27T22:01:00Z", false, TZ, EVENING)).toBe(false);
  });

  it("has nothing to say about no date or a broken one", () => {
    expect(isOverdueIn(null, false, TZ, EVENING)).toBe(false);
    expect(isOverdueIn("soon", true, TZ, EVENING)).toBe(false);
  });
});

describe("dueLabelIn", () => {
  it("labels today and tomorrow on the user's clock", () => {
    expect(dueLabelIn("2026-10-27T19:00:00Z", false, TZ, MORNING)).toBe("Today 3:00 PM");
    expect(dueLabelIn("2026-10-28T01:00:00Z", false, TZ, MORNING)).toBe("Today 9:00 PM");
    expect(dueLabelIn("2026-10-29T01:00:00Z", false, TZ, MORNING)).toBe("Tomorrow 9:00 PM");
    expect(dueLabelIn("2026-10-28T04:00:00Z", true, TZ, MORNING)).toBe("Tomorrow");
  });

  it("names the weekday within the week, and the date beyond it", () => {
    expect(dueLabelIn("2026-10-30T04:00:00Z", true, TZ, MORNING)).toBe("Fri");
    expect(dueLabelIn("2026-11-10T15:00:00Z", false, TZ, MORNING)).toBe("Tue, Nov 10 · 10:00 AM");
    expect(dueLabelIn("2027-01-05T05:00:00Z", true, TZ, MORNING)).toBe("Jan 5, 2027");
  });

  it("says how late, in local days or hours", () => {
    expect(dueLabelIn("2026-10-25T04:00:00Z", true, TZ, MORNING)).toBe("Overdue · 2d");
    expect(dueLabelIn("2026-10-27T19:00:00Z", false, TZ, EVENING)).toBe("Overdue · 3h");
  });
});

describe("runtimeZone", () => {
  it("names a zone", () => {
    expect(runtimeZone()).toMatch(/\w/);
  });
});
