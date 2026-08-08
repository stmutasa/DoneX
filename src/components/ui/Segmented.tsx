"use client";

import { motion } from "framer-motion";
import { useId } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: string;
  icon?: React.ReactNode;
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  size = "md",
  className,
  ariaLabel,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (next: T) => void;
  size?: "sm" | "md";
  className?: string;
  ariaLabel?: string;
}) {
  const layoutId = useId();
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        "flex w-full items-center gap-1 rounded-2xl border border-stroke bg-sunken p-1",
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "relative flex flex-1 items-center justify-center gap-1.5 rounded-xl font-medium transition-colors",
              size === "md" ? "min-h-[38px] px-2 text-[14px]" : "min-h-[32px] px-2 text-[13px]",
              active ? "text-ink" : "text-muted hover:text-ink",
            )}
          >
            {active ? (
              <motion.span
                layoutId={`seg-${layoutId}`}
                className="absolute inset-0 rounded-xl border border-stroke bg-elev shadow-soft"
                transition={{ type: "spring", stiffness: 480, damping: 38 }}
              />
            ) : null}
            <span className="relative flex items-center gap-1.5">
              {opt.icon}
              {opt.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
