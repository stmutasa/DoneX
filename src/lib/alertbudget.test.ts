import { describe, expect, it } from "vitest";
import { MAX_INBOX_ALERTS_PER_DAY, readAlertBudget } from "@/lib/alertbudget";

const DAY = "2026-08-21";

describe("readAlertBudget", () => {
  it("allows the first alert of a fresh day", () => {
    expect(readAlertBudget(null, DAY)).toMatchObject({ allowed: true, used: 0, next: `${DAY}@1` });
  });

  it("allows exactly the daily maximum, then stops", () => {
    let stored: string | null = null;
    const sent: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const budget = readAlertBudget(stored, DAY);
      if (budget.allowed) {
        sent.push(`alert ${i}`);
        stored = budget.next;
      }
    }
    expect(sent).toHaveLength(MAX_INBOX_ALERTS_PER_DAY);
  });

  it("resets when the local day rolls over", () => {
    const spent = `${DAY}@${MAX_INBOX_ALERTS_PER_DAY}`;
    expect(readAlertBudget(spent, DAY).allowed).toBe(false);
    expect(readAlertBudget(spent, "2026-08-22").allowed).toBe(true);
  });

  it("ignores malformed or stale stored values", () => {
    expect(readAlertBudget("garbage", DAY).allowed).toBe(true);
    expect(readAlertBudget(`${DAY}@nope`, DAY).allowed).toBe(true);
    expect(readAlertBudget(`${DAY}@-3`, DAY).used).toBe(0);
  });

  it("honours a custom limit", () => {
    expect(readAlertBudget(`${DAY}@1`, DAY, 1).allowed).toBe(false);
    expect(readAlertBudget(`${DAY}@1`, DAY, 3).allowed).toBe(true);
  });
});
