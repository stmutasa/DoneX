import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Task } from "@/lib/types";
import { allDayKey, setDisplayTimeZone } from "@/lib/format";
import { isoFromLocal } from "@/lib/utils";
import {
  buildDraft,
  changedFields,
  composeDue,
  defaultTime,
  firstOccurrenceKey,
  isAllDay,
  stateFrom,
  todayKey,
  type FormState,
} from "./taskForm";

// The editor reads all-day dates through format.allDayKey, in the display
// zone the app shell sets from settings.tz.
afterEach(() => setDisplayTimeZone(null));

const NY = "America/New_York";
const TOKYO = "Asia/Tokyo";

function task(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Pay rent",
    notes: "",
    status: "open",
    space: "personal",
    createdBy: "owner",
    assignedTo: null,
    priority: 0,
    dueAt: null,
    dueKind: "on",
    allDay: false,
    projectId: null,
    tags: [],
    parentId: null,
    recurrence: null,
    location: null,
    sort: 0,
    completedAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}

function form(over: Partial<FormState> = {}): FormState {
  return { ...stateFrom(null, undefined), title: "Pay rent", ...over };
}

describe("all-day dates", () => {
  it("reads the calendar day in the app's time zone, not the device's", () => {
    // Midnight in Tokyo is the previous afternoon in UTC.
    const dueAt = isoFromLocal("2026-10-26", "00:00", TOKYO);
    expect(dueAt).toBe("2026-10-25T15:00:00.000Z");
    setDisplayTimeZone(TOKYO);
    const s = stateFrom(task({ dueAt, allDay: true }), undefined);
    expect(s.dueDate).toBe("2026-10-26");
    expect(s.dueTime).toBe("");
  });

  it("names the same day as the list for an older device-midnight value", () => {
    // How the editor wrote all-day dates before: midnight on this device.
    const dueAt = new Date("2026-10-28T00:00:00").toISOString();
    setDisplayTimeZone(NY);
    const s = stateFrom(task({ dueAt, allDay: true }), undefined);
    expect(s.dueDate).toBe(allDayKey(dueAt));
    expect(s.dueDate).toBe("2026-10-28");
  });

  it("writes midnight in the app's time zone", () => {
    expect(composeDue(form({ dueDate: "2026-10-26", allDay: true }), NY)).toBe(
      "2026-10-26T04:00:00.000Z",
    );
  });

  it("round-trips a stored all-day date unchanged", () => {
    for (const tz of [NY, TOKYO, "America/Los_Angeles", "UTC"]) {
      const dueAt = isoFromLocal("2026-10-26", "00:00", tz);
      setDisplayTimeZone(tz);
      const s = stateFrom(task({ dueAt, allDay: true }), undefined);
      expect(buildDraft(s, tz).dueAt).toBe(dueAt);
    }
  });
});

describe("a date without a time", () => {
  it("is saved all-day, not as a hidden 09:00", () => {
    const s = form({ dueDate: "2026-10-27", dueTime: "", allDay: false });
    expect(isAllDay(s)).toBe(true);
    const draft = buildDraft(s, NY);
    expect(draft.allDay).toBe(true);
    expect(draft.dueAt).toBe("2026-10-27T04:00:00.000Z");
  });

  it("is timed once a time is set", () => {
    const draft = buildDraft(form({ dueDate: "2026-10-27", dueTime: "15:00" }), NY);
    expect(draft.allDay).toBe(false);
    expect(draft.dueAt).toBe(new Date("2026-10-27T15:00").toISOString());
  });

  it("is all-day when the switch is on even if a time is kept", () => {
    const draft = buildDraft(form({ dueDate: "2026-10-27", dueTime: "15:00", allDay: true }), NY);
    expect(draft.allDay).toBe(true);
    expect(draft.dueAt).toBe("2026-10-27T04:00:00.000Z");
  });

  it("no date means no due and not all-day", () => {
    const draft = buildDraft(form({ allDay: true }), NY);
    expect(draft.dueAt).toBeNull();
    expect(draft.allDay).toBe(false);
    expect(draft.dueKind).toBe("on");
  });
});

describe("changedFields", () => {
  const stored = task({ dueAt: isoFromLocal("2026-10-26", "00:00", NY), allDay: true });
  beforeEach(() => setDisplayTimeZone(NY));

  it("sends only the title when only the title changed", () => {
    const base = stateFrom(stored, undefined);
    const edited = { ...base, title: "Pay the rent" };
    expect(changedFields(buildDraft(base, NY), buildDraft(edited, NY))).toEqual({
      title: "Pay the rent",
    });
  });

  it("sends nothing when nothing changed", () => {
    const base = stateFrom(stored, undefined);
    expect(changedFields(buildDraft(base, NY), buildDraft({ ...base }, NY))).toEqual({});
  });

  it("sends the due and its all-day flag together", () => {
    const base = stateFrom(stored, undefined);
    const edited = { ...base, allDay: false, dueTime: "15:00" };
    const patch = changedFields(buildDraft(base, NY), buildDraft(edited, NY));
    expect(patch).toEqual({
      dueAt: new Date("2026-10-26T15:00").toISOString(),
      allDay: false,
    });
  });

  it("leaves the due out when only the due kind changed", () => {
    const base = stateFrom(stored, undefined);
    const edited: FormState = { ...base, dueKind: "by" };
    expect(changedFields(buildDraft(base, NY), buildDraft(edited, NY))).toEqual({ dueKind: "by" });
  });

  it("sends a cleared date as null", () => {
    const base = stateFrom(stored, undefined);
    const edited = { ...base, dueDate: "", dueTime: "" };
    expect(changedFields(buildDraft(base, NY), buildDraft(edited, NY))).toEqual({
      dueAt: null,
      allDay: false,
    });
  });

  it("compares tags and rules by value", () => {
    const base = stateFrom(
      task({ tags: ["home"], recurrence: { freq: "weekly", interval: 1, byWeekday: [1] } }),
      undefined,
    );
    const same = {
      ...base,
      tags: ["home"],
      recurrence: { freq: "weekly" as const, interval: 1, byWeekday: [1] },
    };
    expect(changedFields(buildDraft(base, NY), buildDraft(same, NY))).toEqual({});
  });
});

describe("firstOccurrenceKey", () => {
  // 2026-10-27 is a Tuesday.
  const today = "2026-10-27";

  it("daily and yearly start today", () => {
    expect(firstOccurrenceKey({ freq: "daily" }, today)).toBe(today);
    expect(firstOccurrenceKey({ freq: "yearly" }, today)).toBe(today);
  });

  it("weekly starts on the next chosen weekday", () => {
    expect(firstOccurrenceKey({ freq: "weekly", byWeekday: [2] }, today)).toBe(today);
    expect(firstOccurrenceKey({ freq: "weekly", byWeekday: [1] }, today)).toBe("2026-11-02");
    expect(firstOccurrenceKey({ freq: "weekly", byWeekday: [1, 4] }, today)).toBe("2026-10-29");
    expect(firstOccurrenceKey({ freq: "weekly", byWeekday: [] }, today)).toBe(today);
  });

  it("monthly starts on the next matching day, clamped to the month", () => {
    expect(firstOccurrenceKey({ freq: "monthly", byMonthDay: 27 }, today)).toBe(today);
    expect(firstOccurrenceKey({ freq: "monthly", byMonthDay: 30 }, today)).toBe("2026-10-30");
    expect(firstOccurrenceKey({ freq: "monthly", byMonthDay: 15 }, today)).toBe("2026-11-15");
    expect(firstOccurrenceKey({ freq: "monthly", byMonthDay: 31 }, "2026-11-05")).toBe("2026-11-30");
    expect(firstOccurrenceKey({ freq: "monthly", byMonthDay: 10 }, "2026-12-20")).toBe("2027-01-10");
    expect(firstOccurrenceKey({ freq: "monthly", interval: 3, byMonthDay: 1 }, today)).toBe(
      "2026-11-01",
    );
  });
});

describe("defaultTime", () => {
  const at = (h: number, m = 0) => new Date(2026, 9, 27, h, m);

  it("is 09:00 for another day or before 09:00 today", () => {
    expect(defaultTime("2026-10-28", at(15))).toBe("09:00");
    expect(defaultTime("2026-10-27", at(8, 30))).toBe("09:00");
  });

  it("is the next hour once 09:00 has passed today", () => {
    expect(defaultTime("2026-10-27", at(14, 20))).toBe("15:00");
    expect(defaultTime("2026-10-27", at(9))).toBe("10:00");
    expect(defaultTime("2026-10-27", at(23, 30))).toBe("23:59");
  });
});

describe("todayKey", () => {
  // London Oct 27 01:39 is still Oct 26 21:39 in New York.
  const now = new Date("2026-10-27T01:39:00Z");

  it("counts today in the app's zone, as quick-add does", () => {
    expect(todayKey(NY, now)).toBe("2026-10-26");
    expect(todayKey("Europe/London", now)).toBe("2026-10-27");
    expect(todayKey(TOKYO, new Date("2026-10-26T15:30:00Z"))).toBe("2026-10-27");
  });

  it("falls back to the device's day without a known zone", () => {
    expect(todayKey("Not/A_Zone", now)).toBe(todayKey(undefined, now));
  });
});
