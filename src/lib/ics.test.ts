import { describe, expect, it } from "vitest";
import { eventsFromIcs } from "@/lib/ics";

const NY = "America/New_York";

/** A feed from VEVENT bodies, with CRLF line endings like real ones. */
function feed(...events: string[]): string {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//DoneX//test//EN"];
  for (const e of events) lines.push("BEGIN:VEVENT", ...e.trim().split("\n").map((l) => l.trim()), "END:VEVENT");
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

// The week of Sun Oct 25 – Sat Oct 31 2026 in New York, as the joint
// calendar asks for it: local midnight to local midnight.
const WEEK = {
  from: new Date("2026-10-25T04:00:00.000Z"),
  to: new Date("2026-11-01T04:00:00.000Z"),
  tz: NY,
};

describe("all-day events", () => {
  it("come back as their own date, not UTC midnight", () => {
    const [bday] = eventsFromIcs(
      feed(`
        UID:bday
        DTSTART;VALUE=DATE:20261026
        DTEND;VALUE=DATE:20261027
        SUMMARY:Mom's birthday
      `),
      WEEK,
    );
    expect(bday).toMatchObject({ title: "Mom's birthday", start: "2026-10-26", end: "2026-10-27", allDay: true });
  });

  it("get a one-day end when the feed leaves it out", () => {
    const [e] = eventsFromIcs(feed("UID:x\nDTSTART;VALUE=DATE:20261028\nSUMMARY:Trash day"), WEEK);
    expect(e).toMatchObject({ start: "2026-10-28", end: "2026-10-29" });
  });

  it("are kept to the window by date in the account's zone", () => {
    const events = eventsFromIcs(
      feed(
        "UID:before\nDTSTART;VALUE=DATE:20261024\nDTEND;VALUE=DATE:20261025\nSUMMARY:Saturday before",
        "UID:first\nDTSTART;VALUE=DATE:20261025\nDTEND;VALUE=DATE:20261026\nSUMMARY:First day",
        "UID:last\nDTSTART;VALUE=DATE:20261031\nDTEND;VALUE=DATE:20261101\nSUMMARY:Last day",
        "UID:after\nDTSTART;VALUE=DATE:20261101\nDTEND;VALUE=DATE:20261102\nSUMMARY:Day after",
      ),
      WEEK,
    );
    expect(events.map((e) => e.title)).toEqual(["First day", "Last day"]);
  });

  it("keep a stay that began before the window, under its real start", () => {
    const [stay] = eventsFromIcs(
      feed("UID:v\nDTSTART;VALUE=DATE:20261022\nDTEND;VALUE=DATE:20261027\nSUMMARY:Vacation"),
      WEEK,
    );
    expect(stay).toMatchObject({ start: "2026-10-22", end: "2026-10-27", allDay: true });
  });

  it("repeat as dates too", () => {
    const events = eventsFromIcs(
      feed("UID:w\nDTSTART;VALUE=DATE:20261020\nDTEND;VALUE=DATE:20261021\nRRULE:FREQ=WEEKLY\nSUMMARY:Bins"),
      WEEK,
    );
    expect(events.map((e) => e.start)).toEqual(["2026-10-27"]);
  });
});

describe("timed events", () => {
  it("come back as UTC instants, with the zone they end in when the feed names one", () => {
    const [flight] = eventsFromIcs(
      feed(`
        UID:f
        DTSTART;TZID=America/New_York:20261027T190000
        DTEND;TZID=Europe/London:20261028T070000
        SUMMARY:Flight to London
      `),
      WEEK,
    );
    expect(flight).toMatchObject({
      start: "2026-10-27T23:00:00.000Z",
      end: "2026-10-28T07:00:00.000Z",
      allDay: false,
      endTimeZone: "Europe/London",
    });
  });

  it("say nothing about the zone when the feed only wrote UTC", () => {
    const [e] = eventsFromIcs(
      feed("UID:z\nDTSTART:20261026T150000Z\nDTEND:20261026T160000Z\nSUMMARY:Call"),
      WEEK,
    );
    expect(e.endTimeZone).toBeUndefined();
  });

  it("overlap the window the way Google's timeMin/timeMax do", () => {
    const events = eventsFromIcs(
      feed(
        "UID:a\nDTSTART:20261025T020000Z\nDTEND:20261025T040000Z\nSUMMARY:Ends at the start",
        "UID:b\nDTSTART:20261025T030000Z\nDTEND:20261025T050000Z\nSUMMARY:Straddles the start",
        "UID:c\nDTSTART:20261101T040000Z\nDTEND:20261101T050000Z\nSUMMARY:Starts at the end",
      ),
      WEEK,
    );
    expect(events.map((e) => e.title)).toEqual(["Straddles the start"]);
  });

  it("are sorted by time", () => {
    const events = eventsFromIcs(
      feed(
        "UID:late\nDTSTART:20261026T220000Z\nDTEND:20261026T230000Z\nSUMMARY:Late",
        "UID:allday\nDTSTART;VALUE=DATE:20261026\nDTEND;VALUE=DATE:20261027\nSUMMARY:All day",
        "UID:early\nDTSTART:20261026T130000Z\nDTEND:20261026T140000Z\nSUMMARY:Early",
      ),
      WEEK,
    );
    expect(events.map((e) => e.title)).toEqual(["All day", "Early", "Late"]);
  });
});

describe("recurring events", () => {
  const STANDUP = feed(
    `
      UID:standup
      DTSTART;TZID=America/New_York:20261019T090000
      DTEND;TZID=America/New_York:20261019T093000
      RRULE:FREQ=WEEKLY;BYDAY=MO
      EXDATE;TZID=America/New_York:20261102T090000
      SUMMARY:Standup
    `,
    `
      UID:standup
      RECURRENCE-ID;TZID=America/New_York:20261026T090000
      DTSTART;TZID=America/New_York:20261027T150000
      DTEND;TZID=America/New_York:20261027T153000
      SUMMARY:Standup (moved)
    `,
    `
      UID:standup
      RECURRENCE-ID;TZID=America/New_York:20261109T090000
      DTSTART;TZID=America/New_York:20261109T090000
      DTEND;TZID=America/New_York:20261109T093000
      STATUS:CANCELLED
      SUMMARY:Standup
    `,
  );
  const MONTH = {
    from: new Date("2026-10-25T04:00:00.000Z"),
    to: new Date("2026-11-22T05:00:00.000Z"),
    tz: NY,
  };

  it("show a moved occurrence at its new time and title, and not at the old one", () => {
    const events = eventsFromIcs(STANDUP, MONTH);
    const oct = events.filter((e) => e.start < "2026-11-01");
    expect(oct).toHaveLength(1);
    expect(oct[0]).toMatchObject({ title: "Standup (moved)", start: "2026-10-27T19:00:00.000Z" });
  });

  it("drop excluded and cancelled occurrences", () => {
    const starts = eventsFromIcs(STANDUP, MONTH).map((e) => e.start);
    expect(starts).not.toContain("2026-11-02T14:00:00.000Z"); // EXDATE
    expect(starts).not.toContain("2026-11-09T14:00:00.000Z"); // cancelled override
    expect(starts).toContain("2026-11-16T14:00:00.000Z"); // the rule carries on
  });
});

describe("cancelled events", () => {
  it("are left out", () => {
    const events = eventsFromIcs(
      feed(
        "UID:off\nDTSTART:20261029T150000Z\nDTEND:20261029T160000Z\nSTATUS:CANCELLED\nSUMMARY:Called off",
        "UID:on\nDTSTART:20261029T170000Z\nDTEND:20261029T180000Z\nSTATUS:CONFIRMED\nSUMMARY:Still on",
      ),
      WEEK,
    );
    expect(events.map((e) => e.title)).toEqual(["Still on"]);
  });
});
