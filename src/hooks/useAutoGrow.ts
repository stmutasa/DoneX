"use client";

import { useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

/** Frames to keep looking for a textarea that hasn't attached yet (~0.5s). */
const ATTACH_FRAMES = 30;

/** Keeps a textarea's height matched to its content. */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  max = 480,
): void {
  const last = useRef<{ el: HTMLTextAreaElement; value: string; max: number } | null>(null);

  // Checked after every render rather than on [value] alone: a Sheet unmounts
  // its content when it closes, so reopening the same text mounts a fresh
  // one-row textarea that still needs sizing.
  useLayoutEffect(() => {
    const grow = (): boolean => {
      const el = ref.current;
      if (!el) return false;
      const prev = last.current;
      if (!prev || prev.el !== el || prev.value !== value || prev.max !== max) {
        last.current = { el, value, max };
        el.style.height = "auto";
        el.style.height = `${Math.min(max, el.scrollHeight)}px`;
      }
      return true;
    };
    if (grow()) return;
    // Not attached yet. A Sheet mounts its content in its own render, which
    // need not re-render this component, so look again for a few frames.
    let frames = 0;
    let id = window.requestAnimationFrame(function check() {
      if (grow() || ++frames >= ATTACH_FRAMES) return;
      id = window.requestAnimationFrame(check);
    });
    return () => window.cancelAnimationFrame(id);
  });
}
