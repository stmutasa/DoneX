import { afterAll, describe, expect, it } from "vitest";
import { byStart, covers, dayKeyOf, layoutLanes, segmentOn, spanOf } from "@/lib/calendarDays";
import type { CalendarEvent } from "@/lib/types";

// The viewer is in New York, behind UTC, where a date read as UTC midnight
// lands on the day before.
const previousTz = process.env.TZ;
process.env.TZ = "America/New_York";
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

const ev = (id: string, start: string, end: string, allDay = false): CalendarEvent => ({
  id,
  title: id,
  start,
  end,
  allDay,
  location: null,
});

describe("the zone this runs in", () => {
  it("is New York", () => {
    expect(new Date("2026-10-26T12:00:00Z").getTimezoneOffset()).toBe(240);
  });
});

describe("dayKeyOf", () => {
  it("keeps an all-day date on its own day", () => {
    expect(dayKeyOf("2026-10-26")).toBe("2026-10-26");
  });

  it("puts an instant on the viewer's local day", () => {
    expect(dayKeyOf("2026-10-27T01:30:00.000Z")).toBe("2026-10-26"); // 9:30 PM in New York
  });
});

describe("spanOf / covers", () => {
  it("runs an all-day event to the day before its exclusive end", () => {
    const vacation = ev("Vacation", "2026-10-30", "2026-11-04", true);
    expect(spanOf(vacation)).toEqual({ first: "2026-10-30", last: "2026-11-03" });
    expect(covers(vacation, "2026-11-01")).toBe(true);
    expect(covers(vacation, "2026-11-04")).toBe(false);
  });

  it("carries an overnight event into the next morning", () => {
    const shift = ev("Night shift", "2026-10-26T23:00:00.000Z", "2026-10-27T11:00:00.000Z"); // 7 PM – 7 AM
    expect(spanOf(shift)).toEqual({ first: "2026-10-26", last: "2026-10-27" });
  });

  it("stops an event that ends at midnight on the day it started", () => {
    const late = ev("Late", "2026-10-27T02:00:00.000Z", "2026-10-27T04:00:00.000Z"); // 10 PM – midnight
    expect(spanOf(late)).toEqual({ first: "2026-10-26", last: "2026-10-26" });
  });
});

describe("segmentOn", () => {
  const shift = ev("Night shift", "2026-10-26T23:00:00.000Z", "2026-10-27T11:00:00.000Z");

  it("draws an overnight event to midnight, then from midnight the next day", () => {
    expect(segmentOn(shift, "2026-10-26")).toMatchObject({ startH: 19, endH: 24, first: true });
    expect(segmentOn(shift, "2026-10-27")).toMatchObject({ startH: 0, endH: 7, first: false });
    expect(segmentOn(shift, "2026-10-28")).toBeNull();
  });

  it("sizes an event that ends at midnight by its full length", () => {
    const late = ev("Late", "2026-10-27T02:00:00.000Z", "2026-10-27T04:00:00.000Z");
    expect(segmentOn(late, "2026-10-26")).toMatchObject({ startH: 22, endH: 24 });
    expect(segmentOn(late, "2026-10-27")).toBeNull();
  });
});

describe("layoutLanes", () => {
  it("sees an overlap however the two feeds wrote their times", () => {
    const owner = ev("owner", "2026-10-26T09:00:00-04:00", "2026-10-26T10:00:00-04:00");
    const partner = ev("partner", "2026-10-26T13:30:00.000Z", "2026-10-26T14:30:00.000Z"); // 9:30 – 10:30
    const day = "2026-10-26";
    const lanes = layoutLanes([segmentOn(owner, day)!, segmentOn(partner, day)!]);
    expect(lanes.get("owner")).toEqual({ lane: 0, lanes: 2 });
    expect(lanes.get("partner")).toEqual({ lane: 1, lanes: 2 });
  });

  it("lets back-to-back events keep the full width", () => {
    const a = ev("a", "2026-10-26T13:00:00.000Z", "2026-10-26T14:00:00.000Z");
    const b = ev("b", "2026-10-26T14:00:00.000Z", "2026-10-26T15:00:00.000Z");
    const lanes = layoutLanes([segmentOn(a, "2026-10-26")!, segmentOn(b, "2026-10-26")!]);
    expect(lanes.get("a")?.lanes).toBe(1);
    expect(lanes.get("b")?.lanes).toBe(1);
  });
});

describe("byStart", () => {
  it("puts all-day first, then times in order whatever their offsets", () => {
    const events = [
      ev("nine", "2026-10-26T09:00:00-04:00", "2026-10-26T10:00:00-04:00"),
      ev("eight", "2026-10-26T12:00:00.000Z", "2026-10-26T13:00:00.000Z"),
      ev("birthday", "2026-10-26", "2026-10-27", true),
    ];
    expect([...events].sort(byStart).map((e) => e.id)).toEqual(["birthday", "eight", "nine"]);
  });
});
