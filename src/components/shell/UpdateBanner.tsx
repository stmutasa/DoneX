"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Button } from "@/components/ui/Button";
import { applyUpdate, isUpdateAvailable } from "@/lib/version";

const CHECK_EVERY_MS = 10 * 60_000;

/**
 * Installed PWAs resume from memory and navigate client-side, so a deployed
 * update can go unseen for days — and the service worker happily keeps serving
 * the cached bundle it already has. This compares the running build against the
 * server's and offers a one-tap refresh that also clears the stale caches.
 */
export function UpdateBanner() {
  const [available, setAvailable] = useState(false);
  const [reloading, setReloading] = useState(false);

  const check = useCallback(async () => {
    if (await isUpdateAvailable()) setAvailable(true);
  }, []);

  useEffect(() => {
    void check();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    const id = window.setInterval(() => void check(), CHECK_EVERY_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(id);
    };
  }, [check]);

  const refresh = async () => {
    setReloading(true);
    await applyUpdate();
  };

  return (
    <AnimatePresence>
      {available ? (
        <motion.div
          initial={{ opacity: 0, y: -16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -16 }}
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
          className="fixed inset-x-0 top-0 z-[95] flex justify-center px-3 pt-[calc(0.5rem+env(safe-area-inset-top,0px))]"
          role="status"
        >
          <div className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-stroke bg-elev/95 px-4 py-3 shadow-lift backdrop-blur">
            <span aria-hidden="true" className="text-[18px]">
              ✨
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14px] font-medium leading-snug text-ink">DoneX was updated</p>
              <p className="text-[12.5px] leading-snug text-muted">
                Refresh to get the newest version.
              </p>
            </div>
            <Button size="sm" variant="primary" loading={reloading} onClick={refresh}>
              Refresh
            </Button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
