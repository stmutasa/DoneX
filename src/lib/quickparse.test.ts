import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "@/lib/quickparse";
import { parseQuickPreview } from "@/lib/format";
import { addDaysToDateKey, localDateKey, localTimeKey } from "@/lib/utils";

const TZ = "America/New_York";
/** Monday 2026-10-26, 10:00 in New York (EDT, the week before DST ends). */
const MONDAY_10AM = new Date("2026-10-26T14:00:00Z");
const local = (iso: string | null | undefined) =>
  iso ? `${localDateKey(iso, TZ)} ${localTimeKey(iso, TZ)}` : null;
const weekdayOf = (dateKey: string) => new Date(`${dateKey}T00:00:00Z`).getUTCDay();

describe("parseQuickAdd", () => {
  it("parses a title with a relative date and explicit time", () => {
    const { draft, matchedText } = parseQuickAdd("buy milk tomorrow 3pm", TZ);
    expect(draft.title).toBe("buy milk");
    expect(draft.allDay).toBe(false);
    expect(draft.dueAt).toBeTruthy();
    expect(localTimeKey(draft.dueAt!, TZ)).toBe("15:00");
    expect(localDateKey(draft.dueAt!, TZ)).toBe(addDaysToDateKey(localDateKey(new Date(), TZ), 1));
    expect(matchedText.due).toBeTruthy();
  });

  it("extracts project, tag, priority and weekly recurrence together", () => {
    const { draft, matchedText } = parseQuickAdd("call mom every sunday #Family @phone !p1", TZ);
    expect(draft.title).toBe("call mom");
    expect(matchedText.project).toBe("Family");
    expect(draft.tags).toEqual(["phone"]);
    expect(matchedText.tags).toEqual(["phone"]);
    expect(draft.priority).toBe(3);
    expect(matchedText.priority).toBe("p1");
    expect(draft.recurrence).toEqual({ freq: "weekly", byWeekday: [0] });
    // A repeat needs a first date: the coming Sunday, all day.
    expect(draft.allDay).toBe(true);
    const dateKey = localDateKey(draft.dueAt!, TZ);
    expect(weekdayOf(dateKey)).toBe(0);
    expect(dateKey >= localDateKey(new Date(), TZ)).toBe(true);
    expect(dateKey <= addDaysToDateKey(localDateKey(new Date(), TZ), 6)).toBe(true);
  });

  it("reads 'quarterly' as every third month", () => {
    const { draft, matchedText } = parseQuickAdd("change the water filter quarterly", TZ);
    expect(draft.title).toBe("change the water filter");
    expect(draft.recurrence).toEqual({ freq: "monthly", interval: 3 });
    expect(matchedText.recurrence).toBe("quarterly");
  });

  it("reads 'every quarter' the same way", () => {
    const { draft } = parseQuickAdd("estimated taxes every quarter", TZ);
    expect(draft.recurrence).toEqual({ freq: "monthly", interval: 3 });
  });

  it("parses a monthly recurrence with 'on the Nth' as byMonthDay (consumed before chrono sees it)", () => {
    const { draft, matchedText } = parseQuickAdd("pay rent every month on the 1st", TZ);
    expect(draft.title).toBe("pay rent");
    expect(draft.recurrence).toEqual({ freq: "monthly", interval: 1, byMonthDay: 1 });
    expect(matchedText.recurrence).toBe("every month on the 1st");
    // "the 1st" is fully consumed by the recurrence match, so chrono never runs on it.
    expect(matchedText.due).toBeUndefined();
    // The first due date comes from the rule instead: the next 1st, all day.
    expect(draft.allDay).toBe(true);
    expect(localDateKey(draft.dueAt!, TZ).slice(8)).toBe("01");
    expect(localTimeKey(draft.dueAt!, TZ)).toBe("00:00");
  });

  it("leaves a plain task with no matched tokens", () => {
    const { draft, matchedText } = parseQuickAdd("just a task", TZ);
    expect(draft.title).toBe("just a task");
    expect(draft.dueAt).toBeUndefined();
    expect(draft.allDay).toBeUndefined();
    expect(draft.priority).toBeUndefined();
    expect(draft.tags).toBeUndefined();
    expect(draft.recurrence).toBeUndefined();
    expect(matchedText).toEqual({ tags: [] });
  });

  it("supports a quoted multi-word project", () => {
    const { draft, matchedText } = parseQuickAdd('finish deck #"Home Reno"', TZ);
    expect(matchedText.project).toBe("Home Reno");
    expect(draft.title).toBe("finish deck");
  });

  it("parses 'every 2 weeks' as a weekly recurrence with interval 2", () => {
    const { draft } = parseQuickAdd("water plants every 2 weeks", TZ);
    expect(draft.recurrence).toEqual({ freq: "weekly", interval: 2 });
    expect(draft.title).toBe("water plants");
  });

  it("normalizes an all-day due date to local midnight", () => {
    const { draft } = parseQuickAdd("submit report friday", TZ);
    expect(draft.allDay).toBe(true);
    expect(draft.dueAt).toBeTruthy();
    expect(localTimeKey(draft.dueAt!, TZ)).toBe("00:00");
    const dateKey = localDateKey(draft.dueAt!, TZ);
    const weekday = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
    expect(weekday).toBe(5); // Friday
    expect(dateKey >= localDateKey(new Date(), TZ)).toBe(true);
  });

  it("strips multiple tags and a priority marker from the title", () => {
    const { draft, matchedText } = parseQuickAdd("review PR @work @urgent !p2", TZ);
    expect(draft.title).toBe("review PR");
    expect(draft.tags).toEqual(["work", "urgent"]);
    expect(draft.priority).toBe(2);
    expect(matchedText.priority).toBe("p2");
  });

  it("accepts word-form priority markers", () => {
    const { draft, matchedText } = parseQuickAdd("clean garage !high", TZ);
    expect(draft.title).toBe("clean garage");
    expect(draft.priority).toBe(3);
    expect(matchedText.priority).toBe("high");
  });

  it("parses a weekday list joined by 'and' into byWeekday", () => {
    const { draft } = parseQuickAdd("gym every monday and friday", TZ);
    expect(draft.recurrence).toEqual({ freq: "weekly", byWeekday: [1, 5] });
    expect(draft.title).toBe("gym");
  });

  it("treats 'by <date>' as a deadline and strips the keyword from the title", () => {
    const { draft, matchedText } = parseQuickAdd("renew passport by friday", TZ);
    expect(draft.title).toBe("renew passport");
    expect(draft.dueKind).toBe("by");
    expect(draft.dueAt).toBeTruthy();
    expect(draft.allDay).toBe(true);
    expect(matchedText.due?.toLowerCase()).toBe("by friday");
  });

  it("treats 'before <date>' as a deadline", () => {
    const { draft } = parseQuickAdd("file taxes before april 15", TZ);
    expect(draft.title).toBe("file taxes");
    expect(draft.dueKind).toBe("by");
  });

  it("does not flag a deadline when 'by' precedes something other than the date", () => {
    const { draft } = parseQuickAdd("stop by the store tomorrow", TZ);
    expect(draft.title).toBe("stop by the store");
    expect(draft.dueKind).toBeUndefined();
    expect(draft.dueAt).toBeTruthy();
  });

  it("plain dated tasks stay dueKind-less (defaults to 'on')", () => {
    const { draft } = parseQuickAdd("dentist appointment friday 2pm", TZ);
    expect(draft.dueKind).toBeUndefined();
    expect(draft.allDay).toBe(false);
  });
});

describe("parseQuickAdd tokens", () => {
  it("leaves an email address in the title", () => {
    const { draft, matchedText } = parseQuickAdd("email bob@acme.com about invoice", TZ);
    expect(draft.title).toBe("email bob@acme.com about invoice");
    expect(draft.tags).toBeUndefined();
    expect(matchedText.tags).toEqual([]);
  });

  it("leaves a URL fragment in the title", () => {
    const { draft, matchedText } = parseQuickAdd("read docs.site/page#setup", TZ);
    expect(draft.title).toBe("read docs.site/page#setup");
    expect(matchedText.project).toBeUndefined();
  });

  it("reads names with accents", () => {
    const { draft, matchedText } = parseQuickAdd("#café plan trip @niño", TZ);
    expect(matchedText.project).toBe("café");
    expect(draft.tags).toEqual(["niño"]);
    expect(draft.title).toBe("plan trip");
  });

  it("keeps combining marks in names", () => {
    expect(parseQuickAdd("#किताब padho", TZ)).toMatchObject({
      draft: { title: "padho" },
      matchedText: { project: "किताब" },
    });
    expect(parseQuickAdd("#ซื้อ milk", TZ).matchedText.project).toBe("ซื้อ");
    expect(parseQuickAdd("call @mañana", TZ).draft.tags).toEqual(["mañana"]);
  });

  it("reads a decomposed accent the same as a composed one", () => {
    const { draft, matchedText } = parseQuickAdd("#cafe\u0301 plan trip", TZ);
    expect(matchedText.project).toBe("café");
    expect(draft.title).toBe("plan trip");
  });

  it("accepts curly quotes around a multi-word project", () => {
    const { draft, matchedText } = parseQuickAdd("finish deck #“Home Reno”", TZ);
    expect(matchedText.project).toBe("Home Reno");
    expect(draft.title).toBe("finish deck");
  });

  it("accepts bare !1 to !3 priorities", () => {
    expect(parseQuickAdd("call mom !1", TZ).draft).toMatchObject({ title: "call mom", priority: 3 });
    expect(parseQuickAdd("call mom !2", TZ).draft.priority).toBe(2);
    expect(parseQuickAdd("call mom !3", TZ).draft.priority).toBe(1);
  });

  it("only reads a priority at the start of a word", () => {
    const { draft } = parseQuickAdd("wow!high there", TZ);
    expect(draft.title).toBe("wow!high there");
    expect(draft.priority).toBeUndefined();
  });
});

describe("parseQuickAdd leaves links alone", () => {
  const cases: [string, string | null][] = [
    ["read https://www.nytimes.com/2026/10/26/us/story.html", null],
    ["read https://blog.example.com/posts/2026-11-05-release-notes", null],
    ["watch https://youtu.be/abc?t=3pm", null],
    ["check site.com/2026/11/05/post", null],
    ["email sat@domain.com", null],
    ["email monica.fri@acme.com", null],
    ["review https://github.com/org/repo/pull/1234 tomorrow", "2026-10-27 00:00"],
    ["visit www.example.com/#today #Work friday", "2026-10-30 00:00"],
  ];
  for (const [input, due] of cases) {
    it(`keeps ${JSON.stringify(input)} whole`, () => {
      const { draft } = parseQuickAdd(input, TZ, MONDAY_10AM);
      expect(local(draft.dueAt)).toBe(due);
      const link = input.split(" ").find((w) => /[./@]/.test(w) && w.length > 8)!;
      expect(draft.title).toContain(link);
      // The preview reads no date out of the link either. (Its title keeps
      // date words, so it only matches the saved one when there are none.)
      const preview = parseQuickPreview(input);
      expect(preview.title).toContain(link);
      if (!due) {
        expect(preview.when).toBeNull();
        expect(preview.title).toBe(draft.title);
      }
    });
  }

  it("keeps a link inside a quoted project", () => {
    const { matchedText } = parseQuickAdd('plan #"site.com/launch plan" soon', TZ);
    expect(matchedText.project).toBe("site.com/launch plan");
  });
});

describe("parseQuickAdd recurring tasks get a first due date on the rule", () => {
  it("starts 'every sunday' on the coming Sunday", () => {
    const { draft } = parseQuickAdd("call mom every sunday", TZ, MONDAY_10AM);
    expect(local(draft.dueAt)).toBe("2026-11-01 00:00");
    expect(draft.allDay).toBe(true);
  });

  it("starts today when today is on the rule", () => {
    const sunday = new Date("2026-11-01T15:00:00Z");
    expect(local(parseQuickAdd("call mom every sunday", TZ, sunday).draft.dueAt)).toBe("2026-11-01 00:00");
  });

  it("moves a timed first date onto a weekday the rule includes", () => {
    const friday = parseQuickAdd("gym every friday at 7am", TZ, MONDAY_10AM).draft;
    expect(local(friday.dueAt)).toBe("2026-10-30 07:00");
    expect(friday.allDay).toBe(false);
    // 7am Monday has passed, so the first is Wednesday, not Tuesday.
    const monWed = parseQuickAdd("gym every mon and wed at 7am", TZ, MONDAY_10AM).draft;
    expect(local(monWed.dueAt)).toBe("2026-10-28 07:00");
  });

  it("keeps the time across a DST change", () => {
    // Monday 9am has passed, so the first is the Monday after DST ends.
    const { draft } = parseQuickAdd("standup every monday at 9am", TZ, MONDAY_10AM);
    expect(local(draft.dueAt)).toBe("2026-11-02 09:00");
  });

  it("starts a monthly day rule on the next such day", () => {
    expect(local(parseQuickAdd("pay rent every month on the 1st", TZ, MONDAY_10AM).draft.dueAt)).toBe(
      "2026-11-01 00:00",
    );
    // A 31st in a 30-day month lands on its last day.
    const nov5 = new Date("2026-11-05T15:00:00Z");
    expect(local(parseQuickAdd("bills every month on the 31st", TZ, nov5).draft.dueAt)).toBe(
      "2026-11-30 00:00",
    );
  });

  it("starts a plain interval today", () => {
    const { draft } = parseQuickAdd("water plants every 2 weeks", TZ, MONDAY_10AM);
    expect(local(draft.dueAt)).toBe("2026-10-26 00:00");
    expect(draft.allDay).toBe(true);
  });
});

describe("parseQuickAdd across a DST change", () => {
  const OCT_26_NOON = new Date("2026-10-26T16:00:00Z"); // EDT

  it("keeps the typed time on a date after DST ends", () => {
    const { draft } = parseQuickAdd("dentist nov 5 at 3pm", TZ, OCT_26_NOON);
    expect(draft.dueAt).toBe("2026-11-05T20:00:00.000Z");
    expect(local(draft.dueAt)).toBe("2026-11-05 15:00");
  });

  it("keeps the typed time on a date after DST starts", () => {
    const { draft } = parseQuickAdd("dentist march 20 at 3pm", TZ, new Date("2027-03-01T16:00:00Z"));
    expect(draft.dueAt).toBe("2027-03-20T19:00:00.000Z");
  });

  it("keeps the typed time for a relative date", () => {
    const { draft } = parseQuickAdd("review in 2 weeks at 3pm", TZ, OCT_26_NOON);
    expect(local(draft.dueAt)).toBe("2026-11-09 15:00");
  });

  it("keeps an exact span and an explicit zone as instants", () => {
    expect(parseQuickAdd("stretch in 2 hours", TZ, OCT_26_NOON).draft.dueAt).toBe(
      "2026-10-26T18:00:00.000Z",
    );
    expect(parseQuickAdd("call at 3pm PST", TZ, OCT_26_NOON).draft.dueAt).toBe("2026-10-26T23:00:00.000Z");
  });
});

describe("parseQuickPreview matches the server grammar", () => {
  const cases = [
    "call mom !1",
    "clean garage !high",
    "tidy !med",
    "email bob@acme.com about invoice",
    "read docs.site/page#setup",
    "#café plan trip @niño @phone",
    'finish deck #"Home Reno" !low',
    "plan #one #two",
    "#किताब padho",
    "#cafe\u0301 plan @nin\u0303o",
    "finish deck #“Home Reno”",
  ];
  for (const input of cases) {
    it(`agrees on ${JSON.stringify(input)}`, () => {
      const preview = parseQuickPreview(input);
      const { draft, matchedText } = parseQuickAdd(input, TZ);
      expect(preview.priority ?? undefined).toBe(draft.priority);
      expect(preview.tags).toEqual(matchedText.tags);
      expect(preview.project ?? undefined).toBe(matchedText.project);
      expect(preview.title).toBe(draft.title);
    });
  }
});
