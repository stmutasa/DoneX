"use client";

import { useEffect, useRef } from "react";

interface WakeLockSentinelLike {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", cb: () => void) => void;
}
interface WakeLockLike {
  request: (type: "screen") => Promise<WakeLockSentinelLike>;
}

/** Holds a screen wake lock while `active`; re-acquires after tab visibility returns. */
export function useWakeLock(active: boolean): void {
  const sentinel = useRef<WakeLockSentinelLike | null>(null);

  useEffect(() => {
    let cancelled = false;
    const nav = navigator as Navigator & { wakeLock?: WakeLockLike };
    if (!nav.wakeLock) return;

    const acquire = async () => {
      if (cancelled || !active || document.visibilityState !== "visible") return;
      if (sentinel.current && !sentinel.current.released) return;
      try {
        const lock = await nav.wakeLock!.request("screen");
        if (cancelled || !active) {
          void lock.release().catch(() => undefined);
          return;
        }
        sentinel.current = lock;
        lock.addEventListener("release", () => {
          if (sentinel.current === lock) sentinel.current = null;
        });
      } catch {
        // Not permitted (battery saver, unsupported) — degrade silently.
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    if (active) {
      void acquire();
      document.addEventListener("visibilitychange", onVisibility);
    }

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      const lock = sentinel.current;
      sentinel.current = null;
      if (lock && !lock.released) void lock.release().catch(() => undefined);
    };
  }, [active]);
}
