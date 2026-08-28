/**
 * Per-person colors on shared surfaces (the joint calendar and attribution
 * chips). Each id maps to a --hue-* variable pair defined in globals.css, so
 * every color has a tuned light and dark rendition. Client-safe.
 */

export const JOINT_COLOR_IDS = [
  "blue",
  "pink",
  "orange",
  "violet",
  "green",
  "teal",
  "red",
  "amber",
] as const;

export type JointColorId = (typeof JOINT_COLOR_IDS)[number];

export function isJointColor(value: unknown): value is JointColorId {
  return typeof value === "string" && (JOINT_COLOR_IDS as readonly string[]).includes(value);
}

/** Settings may hold anything (old data, empty string); coerce to a real id. */
export function normalizeJointColor(value: unknown, fallback: JointColorId): JointColorId {
  return isJointColor(value) ? value : fallback;
}

/** Solid color — dots, borders, chip text. */
export function hueVar(id: JointColorId): string {
  return `var(--hue-${id})`;
}

/** Translucent fill — event blocks, chip backgrounds. */
export function hueSoftVar(id: JointColorId): string {
  return `var(--hue-${id}-soft)`;
}
