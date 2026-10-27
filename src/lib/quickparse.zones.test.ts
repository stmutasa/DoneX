import { afterAll, describe, expect, it } from "vitest";
import { parseQuickAdd } from "@/lib/quickparse";
import { localDateKey, localTimeKey } from "@/lib/utils";

// The server runs in UTC and the owner's phone in New York; the same text at
// the same moment must give the same due date in both.
const TZ = "America/New_York";
const ORIGINAL_TZ = process.env.TZ;
const local = (iso: string | null | undefined) => (iso ? `${localDateKey(iso, TZ)} ${localTimeKey(iso, TZ)}` : null);

afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

// Fri Oct 30 2026, 5:00 PM in New York.
const FRIDAY_5PM = new Date("2026-10-30T21:00:00Z");

const cases: [string, Date, string][] = [
  // A weekday and time already gone today means next week.
  ["call bob friday 2pm", FRIDAY_5PM, "2026-11-06 14:00"],
  ["standup fri 9am", FRIDAY_5PM, "2026-11-06 09:00"],
  // Still to come today stays today.
  ["dinner friday 8pm", FRIDAY_5PM, "2026-10-30 20:00"],
  // Within the minute it was typed, a time still counts as now.
  ["submit report by friday 5pm", new Date("2026-10-30T21:00:30Z"), "2026-10-30 17:00"],
  // A time alone, once gone, is tomorrow.
  ["call at 3pm", FRIDAY_5PM, "2026-10-31 15:00"],
  ["call at 9pm", FRIDAY_5PM, "2026-10-30 21:00"],
  // A whole day is only gone once it is over.
  ["friday call", FRIDAY_5PM, "2026-10-30 00:00"],
  ["oct 30 review", FRIDAY_5PM, "2026-10-30 00:00"],
  // A weekday earlier this week is next week's.
  ["monday 9am standup", FRIDAY_5PM, "2026-11-02 09:00"],
  ["tuesday catch up", FRIDAY_5PM, "2026-11-03 00:00"],
  // A day and month already gone this year means next year.
  ["doctor appt 10/30 2:15pm", new Date("2026-10-30T22:00:00Z"), "2027-10-30 14:15"],
  ["renew sep 1", FRIDAY_5PM, "2027-09-01 00:00"],
  // A stated year is kept, even in the past.
  ["file it oct 1 2026", FRIDAY_5PM, "2026-10-01 00:00"],
  // Monday morning, before 9 and after it.
  ["monday 9am standup", new Date("2026-10-26T12:00:00Z"), "2026-10-26 09:00"],
  ["monday 9am standup", new Date("2026-10-26T14:00:00Z"), "2026-11-02 09:00"],
];

for (const zone of ["UTC", "America/New_York", "America/Los_Angeles", "Asia/Kolkata"]) {
  describe(`quick-add dates with the process in ${zone}`, () => {
    for (const [input, ref, want] of cases) {
      it(`${JSON.stringify(input)} at ${ref.toISOString()} is ${want}`, () => {
        process.env.TZ = zone;
        expect(local(parseQuickAdd(input, TZ, ref).draft.dueAt)).toBe(want);
      });
    }

    it("never saves a weekday time in the past", () => {
      process.env.TZ = zone;
      const { draft } = parseQuickAdd("call bob friday 2pm", TZ, FRIDAY_5PM);
      expect(Date.parse(draft.dueAt!)).toBeGreaterThan(FRIDAY_5PM.getTime());
    });

    it("keeps an exact span and an explicit zone as instants", () => {
      process.env.TZ = zone;
      expect(parseQuickAdd("stretch in 2 hours", TZ, FRIDAY_5PM).draft.dueAt).toBe("2026-10-30T23:00:00.000Z");
      // 1pm Pacific has passed (it is 2pm there), so it is tomorrow's.
      expect(parseQuickAdd("call at 1pm PDT", TZ, FRIDAY_5PM).draft.dueAt).toBe("2026-10-31T20:00:00.000Z");
    });
  });
}
