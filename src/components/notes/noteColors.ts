import type { CSSProperties } from "react";

/**
 * The one place hex literals are allowed: note tints are mixed into the
 * surface token so they read correctly in both themes.
 */
export const NOTE_TINT_HEX: Record<string, string> = {
  amber: "#f59f00",
  coral: "#f0442e",
  sage: "#5c9a6e",
  sky: "#3b82c4",
  violet: "#8b6fd4",
  sand: "#b99a6b",
};

export function noteSurface(color: string | null | undefined): CSSProperties {
  const hex = color ? NOTE_TINT_HEX[color] : undefined;
  if (!hex) return {};
  return {
    background: `color-mix(in srgb, ${hex} 12%, var(--bg-elev))`,
    borderColor: `color-mix(in srgb, ${hex} 30%, var(--border))`,
  };
}

export function noteSwatch(color: string | null): CSSProperties {
  const hex = color ? NOTE_TINT_HEX[color] : undefined;
  if (!hex) return { background: "var(--bg-sunken)", borderColor: "var(--border-strong)" };
  return {
    background: `color-mix(in srgb, ${hex} 55%, var(--bg-elev))`,
    borderColor: `color-mix(in srgb, ${hex} 70%, var(--border))`,
  };
}
