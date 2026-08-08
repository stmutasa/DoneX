"use client";

import { forwardRef, useId } from "react";
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";

const FIELD_BASE =
  "w-full rounded-2xl border border-stroke bg-sunken px-3.5 text-[15px] text-ink placeholder:text-faint " +
  "transition-colors focus:border-stroke-strong focus:outline-none focus:ring-2 focus:ring-accent/35 " +
  "disabled:opacity-50";

export function FieldLabel({
  htmlFor,
  children,
  hint,
}: {
  htmlFor?: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-3">
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-muted">
        {children}
      </label>
      {hint ? <span className="text-[12px] text-faint">{hint}</span> : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, leading, trailing, className, id, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <div className="w-full">
      {label ? (
        <FieldLabel htmlFor={inputId} hint={hint}>
          {label}
        </FieldLabel>
      ) : null}
      <div className="relative flex items-center">
        {leading ? (
          <span className="pointer-events-none absolute left-3 text-faint">{leading}</span>
        ) : null}
        <input
          ref={ref}
          id={inputId}
          className={cn(
            FIELD_BASE,
            "h-11",
            leading && "pl-10",
            trailing && "pr-11",
            className,
          )}
          {...rest}
        />
        {trailing ? <span className="absolute right-2 flex items-center">{trailing}</span> : null}
      </div>
    </div>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: ReactNode;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { label, hint, className, id, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <div className="w-full">
      {label ? (
        <FieldLabel htmlFor={inputId} hint={hint}>
          {label}
        </FieldLabel>
      ) : null}
      <textarea
        ref={ref}
        id={inputId}
        className={cn(FIELD_BASE, "resize-none py-2.5 leading-relaxed", className)}
        {...rest}
      />
    </div>
  );
});

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: ReactNode;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { label, hint, className, id, children, ...rest },
  ref,
) {
  const auto = useId();
  const inputId = id ?? auto;
  return (
    <div className="w-full">
      {label ? (
        <FieldLabel htmlFor={inputId} hint={hint}>
          {label}
        </FieldLabel>
      ) : null}
      <div className="relative">
        <select
          ref={ref}
          id={inputId}
          className={cn(FIELD_BASE, "h-11 appearance-none pr-9", className)}
          {...rest}
        >
          {children}
        </select>
        <svg
          viewBox="0 0 24 24"
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
    </div>
  );
});

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-7 w-[46px] shrink-0 rounded-full border transition-colors duration-200 disabled:opacity-40",
        checked ? "border-transparent bg-sunrise" : "border-stroke bg-sunken",
      )}
    >
      <span
        className={cn(
          "absolute top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-elev shadow-soft transition-all duration-200",
          checked ? "left-[23px]" : "left-[3px]",
        )}
      />
    </button>
  );
}

export function SwitchRow({
  label,
  description,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-h-[44px] items-center justify-between gap-4 py-1">
      <div className="min-w-0">
        <div className="text-[15px] text-ink">{label}</div>
        {description ? <div className="mt-0.5 text-[13px] text-muted">{description}</div> : null}
      </div>
      <Switch checked={checked} onChange={onChange} label={label} disabled={disabled} />
    </div>
  );
}
