import { describe, expect, it } from "vitest";
import { classifyCalendarLink, explainFeedFailure } from "@/lib/calendarLinks";

describe("classifyCalendarLink", () => {
  it("accepts a Google secret iCal address", () => {
    const v = classifyCalendarLink(
      "https://calendar.google.com/calendar/ical/someone%40gmail.com/private-9f8b7a6c5d/basic.ics",
    );
    expect(v).toEqual({ kind: "google-secret", problem: null });
  });

  it("rejects the public address with the fix", () => {
    const v = classifyCalendarLink(
      "https://calendar.google.com/calendar/ical/someone%40gmail.com/public/basic.ics",
    );
    expect(v.kind).toBe("google-public");
    expect(v.problem).toMatch(/Secret address/i);
  });

  it("rejects the embed and cid view links", () => {
    for (const url of [
      "https://calendar.google.com/calendar/embed?src=someone%40gmail.com&ctz=America%2FNew_York",
      "https://calendar.google.com/calendar/u/0?cid=c29tZW9uZUBnbWFpbC5jb20",
    ]) {
      const v = classifyCalendarLink(url);
      expect(v.kind).toBe("google-view");
      expect(v.problem).toMatch(/not a feed/i);
    }
  });

  it("accepts iCloud webcal links and plain .ics urls", () => {
    expect(classifyCalendarLink("webcal://p01.icloud.com/published/2/abc").kind).toBe("webcal");
    expect(classifyCalendarLink("https://example.com/feeds/home.ics").problem).toBeNull();
  });

  it("tells someone who pasted an email address where that belongs", () => {
    expect(classifyCalendarLink("her@gmail.com").problem).toMatch(/Shared with you/i);
  });

  it("treats empty input as nothing to complain about", () => {
    expect(classifyCalendarLink("   ")).toEqual({ kind: "empty", problem: null });
  });
});

describe("explainFeedFailure", () => {
  it("names the public-calendar mistake on a 404", () => {
    const msg = explainFeedFailure(
      "https://calendar.google.com/calendar/ical/someone%40gmail.com/public/basic.ics",
      404,
    );
    expect(msg).toMatch(/isn't public/i);
  });

  it("falls back to a generic reading for other feeds", () => {
    expect(explainFeedFailure("https://example.com/x.ics", 404)).toMatch(/not found/i);
    expect(explainFeedFailure("https://example.com/x.ics", 500)).toMatch(/HTTP 500/);
  });
});
