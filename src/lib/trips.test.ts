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
  zoneOffsetMinutes,
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

// Titles as confirmation emails write them, with each time in its own offset.
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

const NY = "America/New_York";

/** An all-day booking, the way both feeds now send one: bare dates, end exclusive. */
const allDay = (title: string, start: string, end: string): CalendarEvent => ({
  ...ev(title, start, end),
  allDay: true,
});

/** A timed event as the feeds send it: a UTC instant and the zone it ends in. */
const zoned = (title: string, start: string, end: string, endTimeZone: string): CalendarEvent => ({
  ...ev(title, start, end),
  endTimeZone,
});

describe("naming the trip", () => {
  const DENVER = [
    ev("Flight to Denver (LGA → DEN)", "2026-10-23T12:00:00.000Z", "2026-10-23T16:30:00.000Z"),
    ev("Hotel — Westin Denver", "2026-10-23T21:00:00.000Z", "2026-10-27T17:00:00.000Z"),
    ev("Flight to New York (DEN → LGA)", "2026-10-27T19:00:00.000Z", "2026-10-28T00:30:00.000Z"),
  ];

  it("names it after the way out, not the flight home", () => {
    const [trip] = detectTrips(DENVER);
    expect(trip.destination).toBe("Denver");
    expect(trip.start).toBe("2026-10-23T12:00:00.000Z");
  });

  it("falls back to where the flight home leaves from when the way out is missing", () => {
    const [trip] = detectTrips(DENVER.slice(1));
    expect(trip.destination).toBe("DEN");
  });

  it("keeps the only flight as the way out after a short airport hotel", () => {
    const [trip] = detectTrips(
      [
        zoned("Hotel — Hilton JFK Airport", "2026-11-04T01:00:00.000Z", "2026-11-04T13:00:00.000Z", NY),
        zoned("Flight to London (JFK → LHR)", "2026-11-04T15:00:00.000Z", "2026-11-04T22:00:00.000Z", "Europe/London"),
      ],
      { tz: NY, now: new Date("2026-11-04T20:00:00Z") },
    );
    expect(trip.destination).toBe("London");
    expect(trip.timeZone).toBe("Europe/London");
  });

  it("keeps the only flight as the way out after a car to the airport", () => {
    const [trip] = detectTrips([
      ev("Hertz rental car — LGA", "2026-11-04T10:00:00.000Z", "2026-11-04T13:00:00.000Z"),
      ev("Flight to Paris (JFK → CDG)", "2026-11-04T15:00:00.000Z", "2026-11-04T22:30:00.000Z"),
    ]);
    expect(trip.destination).toBe("Paris");
  });

  it("stops the city at a spaced hyphen", () => {
    const [trip] = detectTrips([
      ev("Flight to New York - Delta DL 2845 (JFK → LAX)", "2026-10-01T12:00:00Z", "2026-10-01T18:00:00Z"),
    ]);
    expect(trip.destination).toBe("New York");
  });

  it("keeps a hyphen that is part of the name", () => {
    const [trip] = detectTrips([
      ev("Flight to Winston-Salem - AA 5120", "2026-10-01T12:00:00Z", "2026-10-01T14:00:00Z"),
    ]);
    expect(trip.destination).toBe("Winston-Salem");
  });
});

describe("grouping legs into one trip", () => {
  it("measures the gap from the latest end, so a short stay inside a rental doesn't split it", () => {
    const trips = detectTrips([
      ev("Flight to Denver (LGA → DEN)", "2026-11-04T08:00:00-05:00", "2026-11-04T10:30:00-07:00"),
      ev("Hertz rental car — DEN", "2026-11-04T11:00:00-07:00", "2026-11-10T12:00:00-07:00"),
      ev("Hotel — Westin Denver", "2026-11-04T15:00:00-07:00", "2026-11-06T11:00:00-07:00"),
      ev("Flight to New York (DEN → LGA)", "2026-11-10T14:00:00-07:00", "2026-11-10T19:45:00-05:00"),
    ]);
    expect(trips).toHaveLength(1);
    expect(trips[0].destination).toBe("Denver");
    expect(trips[0].end).toBe("2026-11-10T19:45:00-05:00");
  });

  it("orders legs by time, not by how their offsets spell", () => {
    // The car is picked up at 02:15Z on the 3rd, after the 21:30Z departure,
    // but written in Denver's offset it sorts first as text.
    const [trip] = detectTrips([
      ev("Hertz rental car — DEN", "2026-10-02T20:15:00-06:00", "2026-10-05T10:00:00-06:00"),
      ev("Flight to Denver (LGA → DEN)", "2026-10-02T21:30:00.000Z", "2026-10-03T01:45:00.000Z"),
    ]);
    expect(trip.start).toBe("2026-10-02T21:30:00.000Z");
    expect(trip.destination).toBe("Denver");
  });
});

describe("all-day bookings", () => {
  const STAY = allDay("Hotel — Beach House", "2026-10-28", "2026-11-01");
  const OUT = ev("Flight to Miami (LGA → MIA)", "2026-10-28T12:00:00.000Z", "2026-10-28T15:00:00.000Z");

  it("count from local midnight at home", () => {
    const [trip] = detectTrips([STAY], { tz: NY });
    expect(trip.start).toBe("2026-10-28T04:00:00.000Z");
    expect(trip.end).toBe("2026-11-01T04:00:00.000Z");
    expect(trip.startDay).toBe("2026-10-28");
    expect(trip.endDay).toBe("2026-10-31");
    expect(tripNights(trip)).toBe(4);
  });

  it("let a timed flight on the same day start the trip", () => {
    const [trip] = detectTrips([STAY, OUT], { tz: NY });
    expect(trip.start).toBe(OUT.start);
    expect(trip.startDay).toBeUndefined();
    expect(trip.destination).toBe("Miami");
  });

  it("let a timed flight home on the last day end it", () => {
    const home = ev("Flight to New York (MIA → LGA)", "2026-10-31T20:00:00.000Z", "2026-10-31T23:00:00.000Z");
    const [trip] = detectTrips([OUT, STAY, home], { tz: NY });
    expect(trip.end).toBe(home.end);
    expect(trip.endDay).toBeUndefined();
  });

  it("stay active through the whole last day", () => {
    const trips = detectTrips([STAY], { tz: NY });
    expect(activeTrip(trips, new Date("2026-10-31T23:30:00-04:00"))).not.toBeNull();
    expect(activeTrip(trips, new Date("2026-11-01T00:30:00-04:00"))).toBeNull();
  });
});

describe("the destination's clock", () => {
  const LONDON = [
    zoned("Flight to London (JFK → LHR)", "2026-10-27T23:00:00.000Z", "2026-10-28T07:00:00.000Z", "Europe/London"),
    zoned("Hotel — The Strand", "2026-10-28T15:00:00.000Z", "2026-11-03T11:00:00.000Z", "Europe/London"),
    zoned("Flight to New York (LHR → JFK)", "2026-11-03T13:00:00.000Z", "2026-11-03T21:00:00.000Z", NY),
  ];

  it("comes from the zone the calendar names, not the flight home's", () => {
    const [trip] = detectTrips(LONDON, { now: new Date("2026-10-29T12:00:00Z") });
    expect(trip.timeZone).toBe("Europe/London");
    expect(trip.offsetMinutes).toBe(0);
  });

  it("isn't pinned to home by a home-side leg that comes first", () => {
    const trips = [
      zoned("Hotel — Hilton JFK Airport", "2026-10-27T00:00:00.000Z", "2026-10-27T12:00:00.000Z", NY),
      ...LONDON.slice(0, 1),
      // typed in at home, so it carries the home calendar's zone
      zoned("Hotel — The Strand", "2026-10-28T15:00:00.000Z", "2026-11-03T11:00:00.000Z", NY),
      ...LONDON.slice(2),
    ];
    const [trip] = detectTrips(trips, { tz: NY, now: new Date("2026-10-29T12:00:00Z") });
    expect(trip.destination).toBe("London");
    expect(trip.timeZone).toBe("Europe/London");
    expect(trip.offsetMinutes).toBe(0);
  });

  it("moves with you from one stop to the next", () => {
    const tour = [
      ...LONDON.slice(0, 1),
      zoned("Hotel — The Strand", "2026-10-28T15:00:00.000Z", "2026-10-31T10:00:00.000Z", "Europe/London"),
      zoned("Flight to Paris (LHR → CDG)", "2026-10-31T12:00:00.000Z", "2026-10-31T13:15:00.000Z", "Europe/Paris"),
      zoned("Hotel — Le Marais", "2026-10-31T15:00:00.000Z", "2026-11-03T10:00:00.000Z", "Europe/Paris"),
      zoned("Flight to New York (CDG → JFK)", "2026-11-03T13:00:00.000Z", "2026-11-03T21:00:00.000Z", NY),
    ];
    const at = (iso: string) => detectTrips(tour, { tz: NY, now: new Date(iso) })[0];
    expect(at("2026-10-29T12:00:00Z").timeZone).toBe("Europe/London");
    expect(at("2026-11-01T12:00:00Z")).toMatchObject({ timeZone: "Europe/Paris", offsetMinutes: 60 });
    expect(at("2026-11-03T15:00:00Z").timeZone).toBe("Europe/Paris"); // on the flight home
  });

  it("is read for now, so it follows a DST change mid-trip", () => {
    const chicago = [
      zoned("Flight to Chicago — UA 200", "2026-10-30T11:00:00.000Z", "2026-10-30T14:00:00.000Z", "America/Chicago"),
      zoned("Hotel — Loop", "2026-10-30T20:00:00.000Z", "2026-11-03T16:00:00.000Z", "America/Chicago"),
    ];
    expect(detectTrips(chicago, { now: new Date("2026-10-31T12:00:00Z") })[0].offsetMinutes).toBe(-300);
    expect(detectTrips(chicago, { now: new Date("2026-11-02T12:00:00Z") })[0].offsetMinutes).toBe(-360);
  });

  it("ignores a zone nobody knows", () => {
    const [trip] = detectTrips([
      zoned("Flight to Nowhere — XX 1", "2026-10-01T12:00:00.000Z", "2026-10-01T14:00:00.000Z", "Mars/Olympus"),
    ]);
    expect(trip.timeZone).toBeNull();
    expect(trip.offsetMinutes).toBeNull();
  });
});

describe("zoneOffsetMinutes", () => {
  it("reads a zone's offset at a moment", () => {
    expect(zoneOffsetMinutes(NY, new Date("2026-10-26T12:00:00Z"))).toBe(-240);
    expect(zoneOffsetMinutes(NY, new Date("2026-11-02T12:00:00Z"))).toBe(-300);
  });

  it("admits when it doesn't know the zone", () => {
    expect(zoneOffsetMinutes("Not/AZone", new Date())).toBeNull();
  });
});
