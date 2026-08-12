import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "@/lib/quickparse";
import { addDaysToDateKey, localDateKey, localTimeKey } from "@/lib/utils";

const TZ = "America/New_York";

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
    expect(draft.dueAt).toBeUndefined();
  });

  it("parses a monthly recurrence with 'on the Nth' as byMonthDay (consumed before chrono sees it)", () => {
    const { draft, matchedText } = parseQuickAdd("pay rent every month on the 1st", TZ);
    expect(draft.title).toBe("pay rent");
    expect(draft.recurrence).toEqual({ freq: "monthly", interval: 1, byMonthDay: 1 });
    expect(matchedText.recurrence).toBe("every month on the 1st");
    // "the 1st" is fully consumed by the recurrence match, so chrono never runs on it.
    expect(draft.dueAt).toBeUndefined();
    expect(matchedText.due).toBeUndefined();
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
