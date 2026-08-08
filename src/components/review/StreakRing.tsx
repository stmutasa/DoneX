"use client";

import { useId } from "react";

const SIZE = 148;
const STROKE = 11;

export function StreakRing({ days, goal = 7 }: { days: number; goal?: number }) {
  const gradientId = useId();
  const r = (SIZE - STROKE) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.min(1, days / Math.max(1, goal));

  return (
    <div className="relative grid place-items-center" style={{ width: SIZE, height: SIZE }}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--grad-a)" />
            <stop offset="100%" stopColor="var(--grad-b)" />
          </linearGradient>
        </defs>
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={r}
          fill="none"
          stroke="var(--bg-sunken)"
          strokeWidth={STROKE}
        />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={r}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={`${c * pct} ${c}`}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          style={{ transition: "stroke-dasharray 600ms cubic-bezier(0.22,1,0.36,1)" }}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-[40px] font-semibold leading-none tracking-tight text-ink">
          {days}
        </span>
        <span className="mt-1 text-[12px] font-medium uppercase tracking-[0.1em] text-faint">
          day streak
        </span>
      </div>
    </div>
  );
}
