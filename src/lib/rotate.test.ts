import { describe, expect, it } from "vitest";
import { rotatingSample, rotationSlot, seededShuffle } from "@/lib/rotate";

const items = Array.from({ length: 20 }, (_, i) => `task-${i}`);

describe("rotationSlot", () => {
  it("holds steady inside a window and ticks over at the boundary", () => {
    const base = new Date("2026-08-14T00:00:00Z");
    const slot = rotationSlot(3, base);
    expect(rotationSlot(3, new Date("2026-08-14T02:59:59Z"))).toBe(slot);
    expect(rotationSlot(3, new Date("2026-08-14T03:00:00Z"))).toBe(slot + 1);
    expect(rotationSlot(3, new Date("2026-08-14T06:00:00Z"))).toBe(slot + 2);
  });

  it("honours a different window length", () => {
    const a = rotationSlot(6, new Date("2026-08-14T05:59:00Z"));
    const b = rotationSlot(6, new Date("2026-08-14T06:01:00Z"));
    expect(b).toBe(a + 1);
  });
});

describe("seededShuffle", () => {
  it("is deterministic for a seed", () => {
    expect(seededShuffle(items, 42)).toEqual(seededShuffle(items, 42));
  });

  it("gives a different order for a different seed", () => {
    expect(seededShuffle(items, 1)).not.toEqual(seededShuffle(items, 2));
  });

  it("keeps every item exactly once and leaves the input alone", () => {
    const shuffled = seededShuffle(items, 7);
    expect(shuffled.slice().sort()).toEqual(items.slice().sort());
    expect(items[0]).toBe("task-0");
  });
});

describe("rotatingSample", () => {
  it("returns the list untouched when it already fits", () => {
    const few = items.slice(0, 5);
    expect(rotatingSample(few, 8, 123)).toBe(few);
  });

  it("returns exactly `count` items, stable for the same seed", () => {
    const a = rotatingSample(items, 8, 99);
    expect(a).toHaveLength(8);
    expect(rotatingSample(items, 8, 99)).toEqual(a);
  });

  it("shows a different set as the window advances", () => {
    const a = rotatingSample(items, 8, 500);
    const b = rotatingSample(items, 8, 501);
    expect(a).not.toEqual(b);
  });

  it("eventually surfaces every task across a day of windows", () => {
    const seen = new Set<string>();
    for (let slot = 0; slot < 8; slot += 1) {
      for (const t of rotatingSample(items, 8, slot)) seen.add(t);
    }
    expect(seen.size).toBe(items.length);
  });
});
