import { describe, expect, it } from "vitest";
import {
  wallClockAt,
  offsetGapHours,
  activeTrip,
  classify,
  detectTrips,
  offsetOf,
  packingList,
  tripNights,
  upcomingTrip,
} from "@/lib/trips";
import type { CalendarEvent } from "@/lib/types";

const ev = (title: string, start: string, end: string): CalendarEvent => ({
  id: `${title}-${start}`,
  title,
  start,
  end,
  allDay: false,
  location: null,
});

// The shapes Google actually writes from confirmation emails.
const DALLAS = [
  ev(
    "Flight to Dallas — Southwest WN 2845 (LGA → DAL)",
    "2026-09-04T17:30:00-04:00",
    "2026-09-04T21:20:00-05:00",
  ),
  ev("Hotel — The Westin Dallas Stonebriar", "2026-09-04T22:00:00-05:00", "2026-09-07T11:00:00-05:00"),
  ev("National rental car — DAL (Midsize)", "2026-09-04T22:10:00-05:00", "2026-09-07T09:00:00-05:00"),
  ev(
    "Flight to New York — Southwest WN 118 (DAL → LGA)",
    "2026-09-07T13:00:00-05:00",
    "2026-09-07T17:15:00-04:00",
  ),
];

const NOISE = [
  ev("Work Block", "2026-09-02T08:30:00-04:00", "2026-09-02T13:30:00-04:00"),
  ev("Dinner with Annette", "2026-09-03T19:00:00-04:00", "2026-09-03T21:00:00-04:00"),
];

describe("classify", () => {
  it("knows the three kinds of travel booking", () => {
    expect(classify("Flight to Dallas — Southwest WN 2845")).toBe("flight");
    expect(classify("Hotel — The Westin Dallas Stonebriar")).toBe("stay");
    expect(classify("National rental car — DAL (Midsize)")).toBe("car");
  });

  it("ignores ordinary life", () => {
    expect(classify("Work Block")).toBeNull();
    expect(classify("Dinner with Annette")).toBeNull();
    expect(classify("Infinity Teleradiology Shift")).toBeNull();
  });
});

describe("detectTrips", () => {
  it("pulls one trip out of a week of events", () => {
    const trips = detectTrips([...NOISE, ...DALLAS]);
    expect(trips.length).toBe(1);
    expect(trips[0].destination).toBe("Dallas");
    expect(trips[0].legs.length).toBe(4);
  });

  it("runs from the outbound flight to the flight home", () => {
    const [trip] = detectTrips(DALLAS);
    expect(trip.start).toBe("2026-09-04T17:30:00-04:00");
    expect(trip.end).toBe("2026-09-07T17:15:00-04:00");
  });

  it("reads the destination's clock off the calendar", () => {
    const [trip] = detectTrips(DALLAS);
    expect(trip.offsetMinutes).toBe(-300); // Dallas, CDT
  });

  it("falls back to the airport code when the title has no city", () => {
    const [trip] = detectTrips([
      ev("Flight — AA 1201 (JFK → MIA)", "2026-10-01T08:00:00-04:00", "2026-10-01T11:05:00-04:00"),
      ev("Hotel — Beachside", "2026-10-01T15:00:00-04:00", "2026-10-04T11:00:00-04:00"),
    ]);
    expect(trip.destination).toBe("MIA");
  });

  it("keeps two separate trips apart", () => {
    const october = [
      ev("Flight to Chicago — UA 200", "2026-10-10T07:00:00-04:00", "2026-10-10T09:00:00-05:00"),
      ev("Hotel — Loop", "2026-10-10T15:00:00-05:00", "2026-10-12T11:00:00-05:00"),
    ];
    const trips = detectTrips([...DALLAS, ...october]);
    expect(trips.length).toBe(2);
    expect(trips.map((t) => t.destination)).toEqual(["Dallas", "Chicago"]);
  });

  it("does not call a single rental car a trip", () => {
    expect(detectTrips([ev("Hertz rental car — pickup", "2026-09-01T09:00:00-04:00", "2026-09-01T11:00:00-04:00")]))
      .toEqual([]);
  });

  it("counts a multi-night hotel with no flight as a trip", () => {
    const trips = detectTrips([
      ev("Hotel — Mountain Lodge", "2026-11-01T16:00:00-04:00", "2026-11-04T10:00:00-04:00"),
    ]);
    expect(trips.length).toBe(1);
  });

  it("finds nothing in a week with no travel", () => {
    expect(detectTrips(NOISE)).toEqual([]);
  });
});

describe("when a trip is on", () => {
  const trips = detectTrips(DALLAS);

  it("is active between the flights", () => {
    expect(activeTrip(trips, new Date("2026-09-05T12:00:00-05:00"))?.destination).toBe("Dallas");
  });

  it("is not active before or after", () => {
    expect(activeTrip(trips, new Date("2026-09-04T09:00:00-04:00"))).toBeNull();
    expect(activeTrip(trips, new Date("2026-09-08T09:00:00-04:00"))).toBeNull();
  });

  it("shows up as upcoming a few days out", () => {
    expect(upcomingTrip(trips, 3, new Date("2026-09-02T09:00:00-04:00"))?.destination).toBe("Dallas");
  });

  it("is not 'upcoming' once it has started", () => {
    expect(upcomingTrip(trips, 3, new Date("2026-09-05T09:00:00-05:00"))).toBeNull();
  });

  it("is not 'upcoming' while it is still weeks away", () => {
    expect(upcomingTrip(trips, 3, new Date("2026-08-20T09:00:00-04:00"))).toBeNull();
  });
});

describe("packingList", () => {
  const [trip] = detectTrips(DALLAS);

  it("covers the basics plus what this trip involves", () => {
    const list = packingList(trip);
    expect(list).toContain("Phone charger");
    expect(list).toContain("Boarding pass on phone");
    expect(list).toContain("Driver's licence for the rental");
    expect(list).toContain("Hotel confirmation");
  });

  it("sizes the clothes line to the trip", () => {
    expect(packingList(trip).some((i) => /Clothes for 3 days/.test(i))).toBe(true);
    expect(tripNights(trip)).toBe(3);
  });

  it("adds the longer-trip chores only when it is long", () => {
    const short = detectTrips([
      ev("Flight to Boston — B6 500", "2026-09-01T08:00:00-04:00", "2026-09-01T09:30:00-04:00"),
      ev("Flight to New York — B6 501", "2026-09-01T20:00:00-04:00", "2026-09-01T21:30:00-04:00"),
    ])[0];
    expect(packingList(short)).not.toContain("Hold the mail");
    expect(packingList(trip)).toContain("Hold the mail");
  });
});

describe("offsetOf", () => {
  it("reads the offset an event carries", () => {
    expect(offsetOf("2026-09-04T21:20:00-05:00")).toBe(-300);
    expect(offsetOf("2026-09-04T21:20:00+02:00")).toBe(120);
  });

  it("admits when there is nothing to read", () => {
    expect(offsetOf("2026-09-04T21:20:00Z")).toBeNull();
    expect(offsetOf("2026-09-04")).toBeNull();
  });
});

describe("wallClockAt", () => {
  it("reads the clock where you actually are", () => {
    // 10:30 UTC is 06:30 in New York (-4) and 05:30 in Dallas (-5)
    const at = new Date("2026-09-05T10:30:00Z");
    expect(wallClockAt(at, -240).time).toBe("06:30");
    expect(wallClockAt(at, -300).time).toBe("05:30");
  });

  it("rolls the date and weekday over with the clock", () => {
    const nearMidnight = new Date("2026-09-05T03:30:00Z"); // Saturday in UTC
    const home = wallClockAt(nearMidnight, -240); // 23:30 Friday in New York
    expect(home.dateKey).toBe("2026-09-04");
    expect(home.weekday).toBe(5);
  });

  it("works east of UTC too", () => {
    expect(wallClockAt(new Date("2026-09-05T22:00:00Z"), 120).time).toBe("00:00");
  });
});

describe("offsetGapHours", () => {
  it("says how far the clock moves", () => {
    expect(offsetGapHours(-240, -300)).toBe(-1); // New York → Dallas
    expect(offsetGapHours(-240, 60)).toBe(5); // New York → Paris
    expect(offsetGapHours(-240, -240)).toBe(0);
  });
});
