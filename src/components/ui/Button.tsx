"use client";

import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "soft";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-sunrise text-on-accent shadow-soft hover:brightness-[1.06] active:brightness-95",
  secondary: "bg-elev text-ink border border-stroke hover:border-stroke-strong active:bg-sunken",
  ghost: "text-muted hover:text-ink hover:bg-accent-soft",
  soft: "bg-accent-soft text-accent hover:brightness-105",
  danger: "bg-elev text-danger border border-stroke hover:border-stroke-strong",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-9 px-3 text-[13px] rounded-xl gap-1.5",
  md: "min-h-[44px] px-4 text-sm rounded-2xl gap-2",
  lg: "min-h-[52px] px-5 text-[15px] rounded-2xl gap-2",
};

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent opacity-70",
        className,
      )}
      aria-hidden="true"
    />
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  block?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, block, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        "inline-flex select-none items-center justify-center font-medium transition-[filter,background-color,border-color,transform] duration-150",
        "disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.98]",
        VARIANTS[variant],
        SIZES[size],
        block && "w-full",
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: ButtonVariant;
  size?: "sm" | "md";
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = "ghost", size = "md", active, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full transition-colors duration-150 active:scale-95",
        size === "md" ? "h-11 w-11" : "h-9 w-9",
        VARIANTS[variant],
        variant === "ghost" && "border-0",
        active && "text-accent",
        "disabled:opacity-40",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
