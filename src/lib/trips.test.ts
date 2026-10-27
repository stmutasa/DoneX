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

describe("the night before at the airport", () => {
  const AIRPORT_NIGHT = [
    zoned("Hotel — TWA Hotel at JFK", "2026-11-05T01:00:00.000Z", "2026-11-05T11:00:00.000Z", NY),
    zoned("Flight to London (BA 112) (JFK → LHR)", "2026-11-05T13:30:00.000Z", "2026-11-05T20:30:00.000Z", "Europe/London"),
    zoned("Hotel — The Hoxton, Holborn", "2026-11-05T21:30:00.000Z", "2026-11-09T11:00:00.000Z", "Europe/London"),
    zoned("Flight to New York (BA 177) (LHR → JFK)", "2026-11-09T13:00:00.000Z", "2026-11-09T21:00:00.000Z", NY),
  ];

  it("keeps home time until the flight out", () => {
    const now = new Date("2026-11-05T07:05:00Z"); // 2:05 AM at JFK, 7:05 AM in London
    const trip = activeTrip(detectTrips(AIRPORT_NIGHT, { tz: NY, now }), now);
    expect(trip?.timeZone).toBe(NY);
    expect(trip?.destination).toBe("London");
  });

  it("switches once the flight out has begun", () => {
    const now = new Date("2026-11-05T14:00:00Z");
    expect(activeTrip(detectTrips(AIRPORT_NIGHT, { tz: NY, now }), now)?.timeZone).toBe("Europe/London");
  });

  it("keeps home time through a long rental with a trip inside it", () => {
    const now = new Date("2026-10-27T11:05:00Z");
    const [trip] = detectTrips(
      [
        zoned("Enterprise rent-a-car — Queens Blvd", "2026-10-15T13:00:00.000Z", "2026-11-30T14:00:00.000Z", NY),
        zoned("Flight to Denver (LGA → DEN)", "2026-11-10T13:00:00.000Z", "2026-11-10T17:40:00.000Z", "America/Denver"),
        zoned("Hotel — The Crawford", "2026-11-10T22:00:00.000Z", "2026-11-14T18:00:00.000Z", "America/Denver"),
        zoned("Flight to New York (DEN → LGA)", "2026-11-14T20:00:00.000Z", "2026-11-14T23:40:00.000Z", NY),
      ],
      { tz: NY, now },
    );
    expect(trip.timeZone).toBe(NY);
    expect(trip.destination).toBe("Denver");
  });

  it("doesn't take a one-way flight out for the flight home after a full hotel night", () => {
    const flight = zoned("Flight to London (BA 178) (JFK → LHR)", "2026-11-06T00:00:00.000Z", "2026-11-06T07:00:00.000Z", "Europe/London");
    const now = new Date("2026-11-03T15:00:00Z");
    const timed = zoned("Hotel — Hilton JFK Airport", "2026-11-04T20:00:00.000Z", "2026-11-05T17:00:00.000Z", NY); // 3 PM – noon
    const allDayStay = allDay("Hotel — Hilton JFK Airport", "2026-11-04", "2026-11-05");
    for (const stay of [timed, allDayStay]) {
      const [trip] = detectTrips([stay, flight], { tz: NY, now });
      expect([trip.destination, trip.timeZone]).toEqual(["London", "Europe/London"]);
    }
  });
});

describe("trips with several stops", () => {
  const OUT = zoned("Flight to London (BA 178)", "2026-11-06T00:00:00.000Z", "2026-11-06T07:00:00.000Z", "Europe/London");
  const LDN = zoned("Hotel — The Hoxton, Holborn", "2026-11-06T15:00:00.000Z", "2026-11-09T11:00:00.000Z", "Europe/London");

  it("brings the clock home with a flight into the home zone", () => {
    const now = new Date("2026-11-10T12:00:00Z"); // 7 AM in Boston
    const [trip] = detectTrips(
      [
        OUT,
        LDN,
        zoned("Flight to Boston (BA 213) (LHR → BOS)", "2026-11-09T10:00:00.000Z", "2026-11-09T18:00:00.000Z", NY),
        zoned("Hotel — Omni Parker House", "2026-11-09T20:00:00.000Z", "2026-11-11T16:00:00.000Z", NY),
        zoned("Avis rental car — BOS", "2026-11-11T17:00:00.000Z", "2026-11-11T22:00:00.000Z", NY),
      ],
      { tz: NY, now },
    );
    expect(trip.timeZone).toBe(NY);
    expect(trip.here).toBe("Boston");
  });

  it("keeps the name for where you stay longest, and says where you are now", () => {
    const tour = [
      OUT,
      LDN,
      zoned("Flight to Paris (BA 304)", "2026-11-09T13:00:00.000Z", "2026-11-09T14:20:00.000Z", "Europe/Paris"),
      zoned("Hotel — Le Marais", "2026-11-09T15:00:00.000Z", "2026-11-11T10:00:00.000Z", "Europe/Paris"),
      zoned("Flight to New York (AF 22)", "2026-11-11T12:00:00.000Z", "2026-11-11T20:30:00.000Z", NY),
    ];
    const now = new Date("2026-11-10T08:00:00Z");
    const [trip] = detectTrips(tour, { tz: NY, now });
    expect(trip.destination).toBe("London"); // the packing note keys on this
    expect([trip.here, trip.timeZone]).toEqual(["Paris", "Europe/Paris"]);
  });

  it("names a trip after where you stay, not the connection", () => {
    const [trip] = detectTrips(
      [
        zoned("Flight to Chicago (UA 512) (LGA → ORD)", "2026-11-05T12:00:00.000Z", "2026-11-05T14:45:00.000Z", "America/Chicago"),
        zoned("Flight to Denver (UA 1781) (ORD → DEN)", "2026-11-05T16:00:00.000Z", "2026-11-05T18:40:00.000Z", "America/Denver"),
        zoned("Hotel — The Crawford", "2026-11-05T22:00:00.000Z", "2026-11-08T18:00:00.000Z", "America/Denver"),
        zoned("Flight to Chicago (UA 900) (DEN → ORD)", "2026-11-08T20:00:00.000Z", "2026-11-08T22:30:00.000Z", "America/Chicago"),
        zoned("Flight to New York (UA 3) (ORD → LGA)", "2026-11-09T00:00:00.000Z", "2026-11-09T02:00:00.000Z", NY),
      ],
      { tz: NY, now: new Date("2026-11-07T16:00:00Z") },
    );
    expect(trip.destination).toBe("Denver");
  });
});

describe("a flight out and back with nothing booked between", () => {
  const OUT = zoned("Flight to Denver (UA 1520) (LGA → DEN)", "2026-11-05T13:00:00.000Z", "2026-11-05T17:40:00.000Z", "America/Denver");
  const BACK = zoned("Flight to New York (UA 1521) (DEN → LGA)", "2026-11-08T20:00:00.000Z", "2026-11-08T23:40:00.000Z", NY);
  const now = new Date("2026-11-06T15:00:00Z"); // Fri 8 AM in Denver

  it("is one trip, and you are on it", () => {
    const trips = detectTrips([OUT, BACK], { tz: NY, now });
    expect(trips).toHaveLength(1);
    expect(activeTrip(trips, now)?.destination).toBe("Denver");
  });

  it("joins on the home zone when the titles name no airports", () => {
    const out = zoned("Flight to Denver — UA 1520", OUT.start, OUT.end, "America/Denver");
    const back = zoned("Flight to New York — UA 1521", BACK.start, BACK.end, NY);
    expect(detectTrips([out, back], { tz: NY, now })).toHaveLength(1);
  });

  it("doesn't join a trip that already came home to the next one", () => {
    const trips = detectTrips(
      [
        OUT,
        zoned("Hotel — The Crawford", "2026-11-05T22:00:00.000Z", "2026-11-08T18:00:00.000Z", "America/Denver"),
        BACK,
        zoned("Flight to Boston (B6 1) (LGA → BOS)", "2026-11-15T13:00:00.000Z", "2026-11-15T14:15:00.000Z", NY),
      ],
      { tz: NY, now },
    );
    expect(trips.map((t) => t.destination)).toEqual(["Denver", "Boston"]);
  });

  it("doesn't join flights from different airports", () => {
    const elsewhere = zoned("Flight to New York (B6 2) (BOS → JFK)", BACK.start, BACK.end, NY);
    expect(detectTrips([OUT, elsewhere], { tz: NY, now })).toHaveLength(2);
  });
});

describe("a trip nothing names", () => {
  it("has no destination rather than a made-up one", () => {
    const [trip] = detectTrips(
      [zoned("Hotel — Hyatt Regency", "2026-11-06T21:00:00.000Z", "2026-11-09T16:00:00.000Z", "America/Chicago")],
      { tz: NY, now: new Date("2026-11-07T15:00:00Z") },
    );
    expect(trip.destination).toBeNull();
    expect(trip.here).toBeUndefined();
  });
});
