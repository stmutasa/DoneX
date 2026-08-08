"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { ApiError, fetcher } from "@/lib/api";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { ConfirmProvider } from "@/components/ui/Confirm";
import { ThemeProvider } from "./ThemeProvider";

/** Quietly expected statuses that pages handle with their own inline UI. */
const SILENT = new Set([401, 409]);

function SWRBridge({ children }: { children: ReactNode }) {
  const toast = useToast();
  return (
    <SWRConfig
      value={{
        fetcher,
        revalidateOnFocus: true,
        shouldRetryOnError: false,
        dedupingInterval: 1500,
        onError: (err: unknown) => {
          if (err instanceof ApiError && SILENT.has(err.status)) return;
          if (err instanceof Error) toast.error(err.message);
        },
      }}
    >
      {children}
    </SWRConfig>
  );
}

function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const t = window.setTimeout(() => {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }, 1200);
    return () => window.clearTimeout(t);
  }, []);
  return null;
}

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>
        <ConfirmProvider>
          <SWRBridge>
            <ServiceWorker />
            {children}
          </SWRBridge>
        </ConfirmProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
