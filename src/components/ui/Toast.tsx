"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { IconCheck, IconX } from "./icons";

export type ToastTone = "success" | "error" | "info";

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  action?: { label: string; onClick: () => void };
}

interface ToastApi {
  show: (message: string, tone?: ToastTone, action?: ToastItem["action"]) => void;
  success: (message: string, action?: ToastItem["action"]) => void;
  error: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const show = useCallback<ToastApi["show"]>(
    (message, tone = "info", action) => {
      const id = ++seq.current;
      setItems((prev) => [...prev.slice(-2), { id, message, tone, action }]);
      window.setTimeout(() => dismiss(id), tone === "error" ? 5200 : 3400);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (m, action) => show(m, "success", action),
      error: (m) => show(m, "error"),
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[90] flex flex-col items-center gap-2 px-4 pb-[calc(env(safe-area-inset-bottom,0px)+84px)] sm:pb-8">
        <AnimatePresence initial={false}>
          {items.map((t) => (
            <motion.div
              key={t.id}
              layout
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97 }}
              transition={{ type: "spring", stiffness: 460, damping: 34 }}
              className={cn(
                "pointer-events-auto flex w-full max-w-sm items-center gap-2.5 rounded-2xl border px-4 py-3 shadow-lift",
                "border-stroke bg-elev/95 backdrop-blur",
              )}
              role="status"
            >
              <span
                className={cn(
                  "grid h-5 w-5 shrink-0 place-items-center rounded-full",
                  t.tone === "success" && "bg-ok/15 text-ok",
                  t.tone === "error" && "bg-danger/15 text-danger",
                  t.tone === "info" && "bg-accent-soft text-accent",
                )}
              >
                {t.tone === "error" ? (
                  <IconX className="h-3.5 w-3.5" strokeWidth={2.4} />
                ) : (
                  <IconCheck className="h-3.5 w-3.5" strokeWidth={2.4} />
                )}
              </span>
              <p className="min-w-0 flex-1 text-[14px] leading-snug text-ink">{t.message}</p>
              {t.action ? (
                <button
                  type="button"
                  className="shrink-0 text-[13px] font-medium text-accent"
                  onClick={() => {
                    t.action?.onClick();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              ) : null}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside ToastProvider");
  return ctx;
}
