import { describe, expect, it } from "vitest";
import {
  DEFAULT_HORIZON_DAYS,
  readBasis,
  settleDeadline,
  settlePriority,
} from "@/lib/triageDeadline";

const TODAY = "2026-10-06";
const settle = (over: Partial<Parameters<typeof settleDeadline>[0]> = {}) =>
  settleDeadline({
    dueAtLocal: null,
    basis: "inferred",
    why: "",
    dueKind: "on",
    todayKey: TODAY,
    ...over,
  });

describe("settleDeadline — a date the sender gave", () => {
  it("is kept exactly, time and all", () => {
    const d = settle({ dueAtLocal: "2026-10-09 14:30", basis: "stated", dueKind: "on" });
    expect(d).toEqual({ dueAtLocal: "2026-10-09 14:30", dueKind: "on", inferred: false, why: "" });
  });

  it("keeps a deadline a deadline", () => {
    expect(settle({ dueAtLocal: "2026-10-20", basis: "stated", dueKind: "by" }).dueKind).toBe("by");
  });

  it("is kept even when it has already passed, because that is the truth", () => {
    expect(settle({ dueAtLocal: "2026-09-30", basis: "stated" }).dueAtLocal).toBe("2026-09-30");
  });

  it("is kept even when it is months away", () => {
    expect(settle({ dueAtLocal: "2027-03-01", basis: "stated" }).dueAtLocal).toBe("2027-03-01");
  });
});

describe("settleDeadline — a date that was worked out", () => {
  it("is a whole-day target to finish by", () => {
    const d = settle({ dueAtLocal: "2026-10-08 14:00", why: "Ana is waiting on an answer" });
    expect(d.dueAtLocal).toBe("2026-10-08");
    expect(d.dueKind).toBe("by");
    expect(d.inferred).toBe(true);
    expect(d.why).toBe("Ana is waiting on an answer");
  });

  it("is never set in the past", () => {
    expect(settle({ dueAtLocal: "2026-09-01" }).dueAtLocal).toBe(TODAY);
  });

  it("may be today when the thing really is same-day", () => {
    expect(settle({ dueAtLocal: TODAY }).dueAtLocal).toBe(TODAY);
  });

  it("is pulled back from the far future", () => {
    expect(settle({ dueAtLocal: "2027-06-01" }).dueAtLocal).toBe("2026-11-05");
  });

  it("explains itself even when the model didn't", () => {
    expect(settle({ dueAtLocal: "2026-10-10", why: "" }).why).not.toBe("");
  });
});

describe("settleDeadline — nothing usable", () => {
  it("still gives the task a week", () => {
    const d = settle({ dueAtLocal: null });
    expect(d.dueAtLocal).toBe("2026-10-13");
    // Reads naturally after "No date was given — " on the card.
    expect(d.why).toBe("a week, by default");
    expect(DEFAULT_HORIZON_DAYS).toBe(7);
    expect(d.inferred).toBe(true);
    expect(d.dueKind).toBe("by");
  });

  it("treats rubbish and impossible dates as nothing", () => {
    expect(settle({ dueAtLocal: "next tuesday-ish" }).dueAtLocal).toBe("2026-10-13");
    expect(settle({ dueAtLocal: "2026-02-31" }).dueAtLocal).toBe("2026-10-13");
  });

  it("does not let a 'stated' label rescue a date that isn't one", () => {
    expect(settle({ dueAtLocal: "", basis: "stated" }).inferred).toBe(true);
  });

  it("crosses month and year ends", () => {
    const d = settleDeadline({
      dueAtLocal: null,
      basis: "inferred",
      why: "",
      dueKind: "by",
      todayKey: "2026-12-29",
    });
    expect(d.dueAtLocal).toBe("2027-01-05");
  });
});

describe("readBasis", () => {
  it("believes 'stated' only when it is said", () => {
    expect(readBasis("stated")).toBe("stated");
    expect(readBasis(" Stated ")).toBe("stated");
  });

  it("counts anything else as a guess", () => {
    expect(readBasis("inferred")).toBe("inferred");
    expect(readBasis(undefined)).toBe("inferred");
    expect(readBasis("maybe")).toBe("inferred");
  });
});

describe("settlePriority", () => {
  it("keeps a real priority", () => {
    expect(settlePriority(1)).toBe(1);
    expect(settlePriority(2)).toBe(2);
    expect(settlePriority(3)).toBe(3);
  });

  it("never leaves a task at 'none'", () => {
    expect(settlePriority(0)).toBe(1);
    expect(settlePriority(null)).toBe(1);
    expect(settlePriority(undefined)).toBe(1);
    expect(settlePriority("high")).toBe(1);
  });

  it("brings the out-of-range back in", () => {
    expect(settlePriority(7)).toBe(3);
    expect(settlePriority(-2)).toBe(1);
    expect(settlePriority(2.6)).toBe(3);
    expect(settlePriority("2")).toBe(2);
  });
});
