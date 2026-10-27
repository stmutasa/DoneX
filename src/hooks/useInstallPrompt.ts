"use client";

import { useCallback, useEffect, useState } from "react";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;
let installedNow = false;
let capturing = false;
let holdBrowserPrompt = false;
const subscribers = new Set<() => void>();

const notify = () => subscribers.forEach((fn) => fn());

/**
 * Says whether this session is the owner's, the only one with an in-app
 * Install row (Settings → Appearance). Only then is the browser's own install
 * offer held back in favour of it. It starts false, so nothing is suppressed
 * until the role is known, and a partner keeps the browser's prompt.
 */
export function setInstallPromptOwner(isOwner: boolean): void {
  holdBrowserPrompt = isOwner;
}

/**
 * Starts listening for the browser's install offer; safe to call repeatedly.
 * Browsers fire `beforeinstallprompt` once per page load, soon after it, and
 * usually long before Settings opens, so this runs as soon as the module is
 * first imported rather than when a component mounts. The event is kept
 * either way, so the Install row can still use one the browser also offered.
 */
export function captureInstallPrompt(): void {
  if (capturing || typeof window === "undefined") return;
  capturing = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    if (holdBrowserPrompt) e.preventDefault();
    deferred = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installedNow = true;
    notify();
  });
}

captureInstallPrompt();

/** Offers the captured `beforeinstallprompt` so the app can show an Install row. */
export function useInstallPrompt() {
  const [available, setAvailable] = useState(!!deferred);
  const [installed, setInstalled] = useState(installedNow);

  useEffect(() => {
    captureInstallPrompt();
    const sync = () => {
      setAvailable(!!deferred);
      if (installedNow) setInstalled(true);
    };
    subscribers.add(sync);
    sync();
    if (window.matchMedia?.("(display-mode: standalone)").matches) setInstalled(true);
    return () => {
      subscribers.delete(sync);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferred) return false;
    const event = deferred;
    deferred = null;
    notify();
    try {
      await event.prompt();
      const choice = await event.userChoice;
      return choice.outcome === "accepted";
    } catch {
      return false;
    }
  }, []);

  return { available, installed, promptInstall };
}
