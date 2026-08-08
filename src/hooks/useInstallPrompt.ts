"use client";

import { useCallback, useEffect, useState } from "react";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: InstallPromptEvent | null = null;

/** Captures `beforeinstallprompt` so the app can offer an Install row later. */
export function useInstallPrompt() {
  const [available, setAvailable] = useState(!!deferred);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      deferred = e as InstallPromptEvent;
      setAvailable(true);
    };
    const onInstalled = () => {
      deferred = null;
      setAvailable(false);
      setInstalled(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    if (window.matchMedia?.("(display-mode: standalone)").matches) setInstalled(true);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferred) return false;
    const event = deferred;
    deferred = null;
    setAvailable(false);
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
