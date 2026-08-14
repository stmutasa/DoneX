/**
 * Time-bucketed rotation.
 *
 * Picks a subset that is stable inside a window but different in the next one,
 * so a long list (like Anytime on Today) shows fresh faces through the day
 * without reshuffling under your thumb on every render. Deterministic: the
 * same window shows the same picks on the phone and the laptop.
 */

/** Which rotation window we are in. Same number everywhere inside it. */
export function rotationSlot(hours = 3, now: Date = new Date()): number {
  return Math.floor(now.getTime() / (Math.max(1, hours) * 3_600_000));
}

/** mulberry32 — small, fast, deterministic PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Fisher–Yates driven by the seed: same seed → same order, always. */
export function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = items.slice();
  const rand = prng(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A stable sample for this window. Short lists are returned untouched — there
 * is nothing to rotate when everything already fits on screen.
 */
export function rotatingSample<T>(items: T[], count: number, seed: number): T[] {
  if (count <= 0) return [];
  if (items.length <= count) return items;
  return seededShuffle(items, seed).slice(0, count);
}
