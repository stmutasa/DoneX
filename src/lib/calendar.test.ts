import { beforeEach, describe, expect, it, vi } from "vitest";

const googleFetch = vi.fn();

vi.mock("@/lib/db/repos", () => ({
  settingsRepo: { getApp: () => ({ tz: "America/New_York" }) },
}));
vi.mock("@/lib/google/oauth", () => ({
  GOOGLE_NOT_CONNECTED: "not connected",
  isGoogleConnected: () => true,
  googleFetch: (url: string) => googleFetch(url),
  googleApiError: async (_res: Response, what: string) => new Error(`${what} failed`),
}));

const { listEventsRange, toCalendarEvent } = await import("@/lib/google/calendar");

describe("toCalendarEvent", () => {
  it("keeps an all-day event as its bare dates", () => {
    expect(
      toCalendarEvent({ id: "a", summary: "Anniversary", start: { date: "2026-10-26" }, end: { date: "2026-10-27" } }),
    ).toEqual({
      id: "a",
      title: "Anniversary",
      start: "2026-10-26",
      end: "2026-10-27",
      allDay: true,
      location: null,
    });
  });

  it("writes a timed event in UTC, whatever offset Google used", () => {
    const e = toCalendarEvent({
      id: "t",
      summary: "Standup",
      start: { dateTime: "2026-10-26T09:00:00-04:00" },
      end: { dateTime: "2026-10-26T10:00:00-04:00" },
    });
    expect(e).toMatchObject({ start: "2026-10-26T13:00:00.000Z", end: "2026-10-26T14:00:00.000Z", allDay: false });
  });

  it("carries the zone a flight lands in", () => {
    const e = toCalendarEvent({
      summary: "Flight to London (JFK → LHR)",
      start: { dateTime: "2026-10-27T19:00:00-04:00", timeZone: "America/New_York" },
      end: { dateTime: "2026-10-28T03:00:00-04:00", timeZone: "Europe/London" },
    });
    expect(e?.endTimeZone).toBe("Europe/London");
  });

  it("drops cancelled and unreadable events", () => {
    expect(toCalendarEvent({ status: "cancelled", start: { date: "2026-10-26" } })).toBeNull();
    expect(toCalendarEvent({ start: { dateTime: "not a time" } })).toBeNull();
    expect(toCalendarEvent({})).toBeNull();
  });
});

describe("listEventsRange", () => {
  beforeEach(() => googleFetch.mockReset());

  const page = (ids: string[], nextPageToken?: string) =>
    new Response(
      JSON.stringify({
        items: ids.map((id) => ({ id, summary: id, start: { date: "2026-10-26" }, end: { date: "2026-10-27" } })),
        nextPageToken,
      }),
    );

  it("follows every page Google hands back", async () => {
    googleFetch
      .mockResolvedValueOnce(page(["a", "b"], "p2"))
      .mockResolvedValueOnce(page(["c"], "p3"))
      .mockResolvedValueOnce(page(["d"]));
    const events = await listEventsRange("2026-10-25T04:00:00.000Z", "2026-12-06T05:00:00.000Z");
    expect(events.map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
    expect(googleFetch).toHaveBeenCalledTimes(3);
    const urls = googleFetch.mock.calls.map(([url]) => new URL(url as string));
    expect(urls[0].searchParams.get("pageToken")).toBeNull();
    expect(urls[1].searchParams.get("pageToken")).toBe("p2");
    expect(urls[2].searchParams.get("pageToken")).toBe("p3");
  });

  it("stops at a sane number of pages", async () => {
    googleFetch.mockImplementation(async () => page(["x"], "again"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = await listEventsRange("2026-10-25T04:00:00.000Z", "2026-12-06T05:00:00.000Z");
    expect(googleFetch).toHaveBeenCalledTimes(10);
    expect(events).toHaveLength(10);
    warn.mockRestore();
  });
});
