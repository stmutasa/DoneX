"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { ApiError, fetcher } from "@/lib/api";
import { ToastProvider, useToast } from "@/components/ui/Toast";
import { ConfirmProvider } from "@/components/ui/Confirm";
import { ThemeProvider } from "./ThemeProvider";
import { UpdateBanner } from "./UpdateBanner";

/** Quietly expected statuses that pages handle with their own inline UI.
 *  403 = a partner session touching an owner surface — by design, not news. */
const SILENT = new Set([401, 403, 409]);

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
      navigator.serviceWorker
        // The build id in the URL makes each deploy a distinct script, so the
        // browser installs the new worker instead of keeping the byte-identical
        // old one; updateViaCache stops the HTTP cache short-circuiting that.
        .register(`/sw.js?v=${process.env.NEXT_PUBLIC_BUILD_ID ?? "dev"}`, {
          updateViaCache: "none",
        })
        .catch(() => undefined);
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
            <UpdateBanner />
            {children}
          </SWRBridge>
        </ConfirmProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
