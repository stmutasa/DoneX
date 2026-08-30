"use client";

import { useEffect, useState } from "react";

/**
 * Matches a media query, for the handful of places where a layout decision
 * can't be expressed in CSS — a grid drawn from measured pixel maths, say.
 * Prefer Tailwind breakpoints everywhere else.
 *
 * Starts false so server and first client render agree, then settles after
 * mount.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/** True on laptop/desktop widths — Tailwind's `xl` breakpoint. */
export function useIsWideScreen(): boolean {
  return useMediaQuery("(min-width: 1280px)");
}
