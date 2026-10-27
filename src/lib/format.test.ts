import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// A phone in Los Angeles, for a user whose zone is New York.
const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = "America/Los_Angeles";

const { allDayKey, deadlineChip, dueLabel, isOverdue, keyToDate, setDisplayTimeZone } = await import(
  "@/lib/format"
);
const { isoFromLocal } = await import("@/lib/utils");

const NY = "America/New_York";
/** All-day dates are stored at midnight in the user's zone. */
const allDay = (key: string) => isoFromLocal(key, "00:00", NY);

beforeAll(() => {
  vi.useFakeTimers();
  // Tue Oct 27 2026, 9:00 AM in Los Angeles, noon in New York.
  vi.setSystemTime(new Date("2026-10-27T16:00:00Z"));
});

afterEach(() => setDisplayTimeZone(null));

afterAll(() => {
  vi.useRealTimers();
  process.env.TZ = ORIGINAL_TZ;
});

describe("all-day dates without a display zone", () => {
  it("read in the device zone, as before", () => {
    // New York midnight is 9 PM the evening before here.
    expect(isOverdue(allDay("2026-10-27"), true)).toBe(true);
    expect(dueLabel(allDay("2026-10-27"), true)).toBe("Overdue · 1d");
    expect(allDayKey(allDay("2026-10-27"))).toBe("2026-10-26");
  });
});

describe("all-day dates in the display zone", () => {
  it("shows today's task as today, not overdue", () => {
    setDisplayTimeZone(NY);
    expect(isOverdue(allDay("2026-10-27"), true)).toBe(false);
    expect(dueLabel(allDay("2026-10-27"), true)).toBe("Today");
    expect(allDayKey(allDay("2026-10-27"))).toBe("2026-10-27");
  });

  it("labels the days around it", () => {
    setDisplayTimeZone(NY);
    expect(dueLabel(allDay("2026-10-26"), true)).toBe("Overdue · 1d");
    expect(isOverdue(allDay("2026-10-26"), true)).toBe(true);
    expect(dueLabel(allDay("2026-10-28"), true)).toBe("Tomorrow");
    expect(dueLabel(allDay("2026-10-30"), true)).toBe("Fri");
    expect(dueLabel(allDay("2026-11-12"), true)).toBe("Thu, Nov 12");
    expect(dueLabel(allDay("2027-01-04"), true)).toBe("Jan 4, 2027");
  });

  it("reads deadline chips the same way", () => {
    setDisplayTimeZone(NY);
    expect(deadlineChip(allDay("2026-10-27"), true)).toBe("By today");
    // Without the flag, a display-zone midnight counts as a whole day.
    expect(deadlineChip(allDay("2026-10-27"))).toBe("By today");
    expect(deadlineChip(allDay("2026-10-30"))).toBe("By Fri · 3d left");
    expect(deadlineChip(allDay("2026-10-26"))).toBe("Overdue · 1d");
  });

  it("keeps a device-local midnight on its own day", () => {
    setDisplayTimeZone(NY);
    // e.g. a date built on this device from a "YYYY-MM-DD" key
    const local = keyToDate("2026-10-30").toISOString();
    expect(allDayKey(local)).toBe("2026-10-30");
    expect(dueLabel(local, true)).toBe("Fri");
  });

  it("leaves timed tasks in the device zone", () => {
    setDisplayTimeZone(NY);
    // 3 PM in New York is noon here.
    expect(dueLabel("2026-10-27T19:00:00.000Z", false)).toBe("Today 12:00 PM");
    expect(isOverdue("2026-10-27T15:00:00.000Z", false)).toBe(true);
    expect(deadlineChip("2026-10-28T19:00:00.000Z", false)).toBe("By tomorrow");
  });

  it("ignores a zone the runtime does not know", () => {
    setDisplayTimeZone("Not/A_Zone");
    expect(dueLabel(allDay("2026-10-27"), true)).toBe("Overdue · 1d");
  });
});

describe("display zone updates", () => {
  it("tells subscribers once per change, after the current call", async () => {
    const { subscribeDisplayTimeZone, getDisplayTimeZone } = await import("@/lib/format");
    const seen: (string | null)[] = [];
    const stop = subscribeDisplayTimeZone(() => seen.push(getDisplayTimeZone()));
    setDisplayTimeZone(NY);
    expect(seen).toEqual([]);
    await Promise.resolve();
    expect(seen).toEqual([NY]);
    setDisplayTimeZone(NY); // no change, no news
    setDisplayTimeZone("Not/A_Zone"); // read as unset
    await Promise.resolve();
    expect(seen).toEqual([NY, null]);
    stop();
    setDisplayTimeZone(NY);
    await Promise.resolve();
    expect(seen).toEqual([NY, null]);
  });
});

describe("display zone in the browser", () => {
  const store = new Map<string, string>();
  const fakeWindow = {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  };

  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    store.clear();
  });

  it("is remembered, so a cold start reads all-day dates right away", async () => {
    (globalThis as { window?: unknown }).window = fakeWindow;
    vi.resetModules();
    const first = await import("@/lib/format");
    expect(first.getDisplayTimeZone()).toBeNull();
    first.setDisplayTimeZone(NY);
    expect(store.get("donex.displayTz")).toBe(NY);

    // The next page load, before /api/auth/me has answered.
    vi.resetModules();
    const next = await import("@/lib/format");
    expect(next.getDisplayTimeZone()).toBe(NY);
    expect(next.dueLabel(allDay("2026-10-27"), true)).toBe("Today");

    next.setDisplayTimeZone(null);
    expect(store.has("donex.displayTz")).toBe(false);
  });

  it("works without storage", async () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
        removeItem: () => {
          throw new Error("blocked");
        },
      },
    };
    vi.resetModules();
    const mod = await import("@/lib/format");
    expect(mod.getDisplayTimeZone()).toBeNull();
    mod.setDisplayTimeZone(NY);
    expect(mod.getDisplayTimeZone()).toBe(NY);
  });

  it("never touches storage on the server", async () => {
    vi.resetModules();
    const mod = await import("@/lib/format");
    mod.setDisplayTimeZone(NY);
    expect(mod.getDisplayTimeZone()).toBe(NY);
    expect(store.size).toBe(0);
    mod.setDisplayTimeZone(null);
  });
});
