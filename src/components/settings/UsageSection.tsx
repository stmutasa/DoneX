"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher, usageApi } from "@/lib/api";
import type { UsageBucket, UsageRollup, UsageTotals } from "@/lib/usage";
import { formatTokens } from "@/lib/usage";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { SkeletonRows } from "@/components/ui/Misc";
import { useConfirm } from "@/components/ui/Confirm";
import { useToast } from "@/components/ui/Toast";
import { Divider, SettingsCard } from "./common";

interface UsagePayload {
  todayKey: string;
  days: number;
  from: string;
  headline: { today: UsageTotals; week: UsageTotals; month: UsageTotals; all: UsageTotals };
  since: string | null;
  rollup: UsageRollup;
  active: {
    provider: string;
    model: string;
    fallbackProvider: string | null;
    fallbackModel: string | null;
  };
}

const RANGES = [
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
  { value: 90, label: "90 days" },
] as const;

export function UsageSection() {
  const confirm = useConfirm();
  const toast = useToast();
  const [days, setDays] = useState<number>(7);
  const { data, isLoading, mutate } = useSWR<UsagePayload>(`/api/usage?days=${days}`, fetcher, {
    refreshInterval: 5 * 60_000,
  });

  const reset = async () => {
    const ok = await confirm({
      title: "Clear the token history?",
      message: "The counts start again from zero. Nothing else is affected.",
      confirmLabel: "Clear",
      destructive: true,
    });
    if (!ok) return;
    try {
      await usageApi.clear();
      await mutate();
      toast.success("Token history cleared");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not clear it");
    }
  };

  return (
    <SettingsCard
      id="usage"
      title="Token usage"
      description="What the app's AI has spent, as reported by each provider."
    >
      {isLoading && !data ? (
        <SkeletonRows rows={4} />
      ) : !data ? (
        <p className="text-[13px] text-muted">Couldn’t load your usage just now.</p>
      ) : data.headline.all.calls === 0 ? (
        <p className="rounded-2xl border border-stroke bg-sunken px-3.5 py-3 text-[13px] leading-relaxed text-muted">
          Nothing recorded yet. Counting starts with the next briefing, triage run or chat —
          history from before this update isn’t included.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Headline label="Today" totals={data.headline.today} />
            <Headline label="Last 7 days" totals={data.headline.week} />
            <Headline label="Last 30 days" totals={data.headline.month} />
            <Headline label="All time" totals={data.headline.all} />
          </div>

          <Divider />

          <Segmented
            size="sm"
            ariaLabel="Usage range"
            value={days}
            onChange={setDays}
            options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
          />

          <DailyChart daily={data.rollup.daily} />

          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] text-muted">
              {formatTokens(data.rollup.total)} tokens over {data.days} days
            </span>
            <span className="text-[12px] text-faint">
              {data.rollup.calls} call{data.rollup.calls === 1 ? "" : "s"} ·{" "}
              {formatTokens(data.rollup.input)} in / {formatTokens(data.rollup.output)} out
            </span>
          </div>

          <Breakdown title="By company" buckets={data.rollup.byCompany} />
          <Breakdown title="By model" buckets={data.rollup.byModel} />
          <Breakdown title="By what used it" buckets={data.rollup.byFeature} />

          <Divider />

          <p className="text-[12px] leading-snug text-faint">
            Currently on {data.active.provider} · {data.active.model}
            {data.active.fallbackProvider
              ? ` with ${data.active.fallbackProvider} as backup`
              : " with no backup"}
            . Counts come from each provider’s own usage figures, so they match what you’re
            billed for — the app doesn’t estimate them.
            {data.since ? ` Recording since ${data.since}.` : ""}
          </p>

          <Button variant="danger" size="sm" onClick={() => void reset()}>
            Clear history
          </Button>
        </>
      )}
    </SettingsCard>
  );
}

function Headline({ label, totals }: { label: string; totals: UsageTotals }) {
  return (
    <div className="rounded-2xl border border-stroke bg-sunken px-3 py-2.5">
      <div className="text-[11.5px] uppercase tracking-[0.06em] text-faint">{label}</div>
      <div className="mt-0.5 text-[20px] font-semibold tracking-tight text-ink tabular-nums">
        {formatTokens(totals.total)}
      </div>
      <div className="text-[11.5px] text-muted">
        {totals.calls} call{totals.calls === 1 ? "" : "s"}
      </div>
    </div>
  );
}

/** A plain bar per day — enough to spot the day something ran away with it. */
function DailyChart({ daily }: { daily: { dateLocal: string; total: number }[] }) {
  const peak = Math.max(1, ...daily.map((d) => d.total));
  return (
    <div className="flex h-24 items-end gap-[3px]" aria-hidden="true">
      {daily.map((d) => (
        <div
          key={d.dateLocal}
          title={`${d.dateLocal}: ${formatTokens(d.total)} tokens`}
          className="min-w-0 flex-1 rounded-t-sm bg-sunrise"
          style={{
            height: `${Math.max(d.total > 0 ? 4 : 1, Math.round((d.total / peak) * 100))}%`,
            opacity: d.total > 0 ? 1 : 0.25,
          }}
        />
      ))}
    </div>
  );
}

function Breakdown({ title, buckets }: { title: string; buckets: UsageBucket[] }) {
  if (buckets.length === 0) return null;
  return (
    <div>
      <p className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">
        {title}
      </p>
      <ul className="space-y-1.5">
        {buckets.map((b) => (
          <li key={b.key}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">{b.label}</span>
              <span className="shrink-0 text-[13px] tabular-nums text-muted">
                {formatTokens(b.total)}
              </span>
              <span className="w-10 shrink-0 text-right text-[12px] tabular-nums text-faint">
                {Math.round(b.share * 100)}%
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-sunken">
              <div
                className={cn("h-full rounded-full bg-sunrise")}
                style={{ width: `${Math.max(2, Math.round(b.share * 100))}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
