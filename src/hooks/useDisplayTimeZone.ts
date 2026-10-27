"use client";

import { useSyncExternalStore } from "react";
import { getDisplayTimeZone, subscribeDisplayTimeZone } from "@/lib/format";

/** The display zone, re-rendering when it changes. Add it to the deps of any
 *  memo that reads all-day dates. Always null while rendering on the server. */
export function useDisplayTimeZone(): string | null {
  return useSyncExternalStore(subscribeDisplayTimeZone, getDisplayTimeZone, () => null);
}
