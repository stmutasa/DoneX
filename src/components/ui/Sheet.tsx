"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, type PanInfo } from "framer-motion";
import { cn } from "@/lib/utils";
import { IconButton } from "./Button";
import { IconX } from "./icons";

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  /** desktop max width */
  size?: "md" | "lg" | "full";
  className?: string;
}

const SIZE: Record<NonNullable<SheetProps["size"]>, string> = {
  md: "sm:max-w-lg",
  lg: "sm:max-w-2xl",
  full: "sm:max-w-3xl",
};

export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  actions,
  footer,
  children,
  size = "md",
  className,
}: SheetProps) {
  const [mounted, setMounted] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = window.setTimeout(() => panelRef.current?.focus(), 40);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      window.clearTimeout(t);
    };
  }, [open, onClose]);

  if (!mounted) return null;

  const onDragEnd = (_e: unknown, info: PanInfo) => {
    if (info.offset.y > 110 || info.velocity.y > 700) onClose();
  };

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-[70] flex items-end justify-center sm:items-center sm:p-6">
          <motion.div
            className="absolute inset-0 bg-black/50 backdrop-blur-[3px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
          />
          <motion.div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            drag="y"
            dragDirectionLock
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={onDragEnd}
            initial={{ y: "100%", opacity: 0.6 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: "100%", opacity: 0.4 }}
            transition={{ type: "spring", stiffness: 380, damping: 36, mass: 0.8 }}
            className={cn(
              "relative flex max-h-[92dvh] w-full flex-col overflow-hidden bg-elev shadow-lift outline-none",
              "rounded-t-3xl border border-stroke border-b-0 sm:rounded-3xl sm:border-b",
              SIZE[size],
              className,
            )}
          >
            <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-stroke-strong sm:hidden" />
            {title || actions ? (
              <div className="flex items-start gap-3 px-5 pb-3 pt-3 sm:pt-5">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-lg font-semibold tracking-tight text-ink">{title}</h2>
                  {subtitle ? <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p> : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {actions}
                  <IconButton label="Close" onClick={onClose} size="sm">
                    <IconX />
                  </IconButton>
                </div>
              </div>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4">
              {children}
            </div>
            {footer ? (
              <div className="shrink-0 border-t border-stroke bg-elev px-5 py-3 pb-safe">{footer}</div>
            ) : (
              <div className="pb-safe" />
            )}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
