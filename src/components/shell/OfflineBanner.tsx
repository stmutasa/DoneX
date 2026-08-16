"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useSWRConfig } from "swr";
import { matchKey } from "@/lib/api";
import { outboxCount, outboxSyncing, subscribeOutbox, syncOutbox } from "@/lib/offline";
import { useToast } from "@/components/ui/Toast";

function subscribeOnline(cb: () => void): () => void {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

const isOnline = () => navigator.onLine;

/**
 * Slim status strip under the header: shows when you're offline (with the
 * count of changes waiting) and quietly replays the outbox once the
 * connection returns.
 */
export function OfflineBanner() {
  const online = useSyncExternalStore(subscribeOnline, isOnline, () => true);
  const pending = useSyncExternalStore(subscribeOutbox, outboxCount, () => 0);
  const syncing = useSyncExternalStore(subscribeOutbox, outboxSyncing, () => false);
  const { mutate } = useSWRConfig();
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const runSync = useCallback(async () => {
    const result = await syncOutbox();
    if (result.synced > 0 || result.dropped > 0) {
      // Everything task-shaped may have changed on the server now.
      void mutate(matchKey("/api/tasks", "/api/stats", "/api/tags", "/api/projects"));
    }
    if (result.synced > 0) {
      toastRef.current.success(
        `Synced ${result.synced} offline change${result.synced === 1 ? "" : "s"}`,
      );
    }
    if (result.dropped > 0) {
      toastRef.current.error(
        `${result.dropped} offline change${result.dropped === 1 ? "" : "s"} couldn’t sync`,
      );
    }
  }, [mutate]);

  useEffect(() => {
    void runSync();
    const onOnline = () => void runSync();
    const onVisible = () => {
      if (document.visibilityState === "visible") void runSync();
    };
    const interval = window.setInterval(() => {
      if (navigator.onLine) void runSync();
    }, 60_000);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [runSync]);

  if (online && pending === 0) return null;

  return (
    <div
      role="status"
      className="sticky top-0 z-30 border-b border-stroke bg-elev px-4 py-2 text-center text-[13px] font-medium text-warn"
    >
      {!online
        ? pending > 0
          ? `Offline — ${pending} change${pending === 1 ? "" : "s"} will sync when you’re back`
          : "Offline — showing your last-synced lists. Task changes will sync."
        : syncing
          ? "Back online — syncing your changes…"
          : `${pending} change${pending === 1 ? "" : "s"} waiting to sync`}
    </div>
  );
}
