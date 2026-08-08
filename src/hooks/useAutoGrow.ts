"use client";

import { useEffect } from "react";
import type { RefObject } from "react";

/** Keeps a textarea's height matched to its content. */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  max = 480,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(max, el.scrollHeight)}px`;
  }, [ref, value, max]);
}
