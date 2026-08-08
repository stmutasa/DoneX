"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export const PIN_MIN = 4;
export const PIN_MAX = 8;

export function PinPad({
  value,
  onChange,
  onSubmit,
  label,
  autoFocus = true,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
  label: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 150);
      return () => window.clearTimeout(t);
    }
  }, [autoFocus]);

  return (
    <button
      type="button"
      onClick={() => inputRef.current?.focus()}
      className="relative flex w-full flex-col items-center rounded-2xl py-3"
      aria-label={label}
      tabIndex={-1}
    >
      <div className="flex items-center justify-center gap-3 rounded-full border border-transparent px-5 py-3 transition-colors duration-200 [button:focus-within_&]:border-stroke-strong">
        {Array.from({ length: PIN_MAX }).map((_, i) => {
          const filled = i < value.length;
          return (
            <span
              key={i}
              className={cn(
                "block rounded-full transition-all duration-200",
                filled
                  ? "h-3.5 w-3.5 scale-110 bg-sunrise"
                  : i < PIN_MIN
                    ? "h-3 w-3 bg-stroke-strong"
                    : "h-2 w-2 bg-stroke",
              )}
            />
          );
        })}
      </div>
      <input
        ref={inputRef}
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        aria-label={label}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, PIN_MAX))}
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.length >= PIN_MIN) onSubmit?.();
        }}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
      />
    </button>
  );
}
