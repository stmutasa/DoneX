"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "accent" | "ok" | "warn" | "danger";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-5",
        tone === "neutral" && "bg-sunken text-muted",
        tone === "accent" && "bg-accent-soft text-accent",
        tone === "ok" && "bg-ok/12 text-ok",
        tone === "warn" && "bg-warn/15 text-warn",
        tone === "danger" && "bg-danger/12 text-danger",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function CountBadge({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "grid min-w-[18px] place-items-center rounded-full bg-sunrise px-1 text-[10px] font-semibold leading-[18px] text-on-accent",
        className,
      )}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function EmptyState({
  emoji = "✨",
  title,
  message,
  action,
  className,
}: {
  emoji?: string;
  title: string;
  message?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex animate-fade-in flex-col items-center justify-center px-6 py-14 text-center",
        className,
      )}
    >
      <div className="mb-3 grid h-16 w-16 place-items-center rounded-3xl bg-sunken text-3xl">
        {emoji}
      </div>
      <h3 className="text-[17px] font-semibold tracking-tight text-ink">{title}</h3>
      {message ? (
        <p className="mt-1.5 max-w-[30ch] text-[14px] leading-relaxed text-muted">{message}</p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} />;
}

export function SkeletonRows({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2.5", className)}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-2xl border border-stroke bg-elev p-3.5">
          <Skeleton className="h-6 w-6 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5" />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ProgressRing({
  value,
  total,
  size = 20,
  stroke = 2.5,
  className,
}: {
  value: number;
  total: number;
  size?: number;
  stroke?: number;
  className?: string;
}) {
  const safeTotal = Math.max(1, total);
  const pct = Math.min(1, Math.max(0, value / safeTotal));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--border-strong)"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${c * pct} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dasharray 320ms ease" }}
      />
    </svg>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-5 flex items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">{title}</h1>
        {subtitle ? <p className="mt-1 text-[14px] text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </header>
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h2
      className={cn(
        "mb-2 px-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint",
        className,
      )}
    >
      {children}
    </h2>
  );
}
