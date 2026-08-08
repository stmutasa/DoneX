"use client";

import { useState } from "react";
import useSWR from "swr";
import { motion } from "framer-motion";
import { ApiError, assistantApi, fetcher, keys } from "@/lib/api";
import type { StatsSummary, WeeklyReview } from "@/lib/types";
import { weekRangeLabel } from "@/lib/format";
import { Page } from "@/components/shell/Page";
import { PageHeader, Skeleton } from "@/components/ui/Misc";
import { IconButton } from "@/components/ui/Button";
import { IconRefresh, IconSparkles } from "@/components/ui/icons";
import { AiNudge } from "@/components/today/AiNudge";
import { StreakRing } from "@/components/review/StreakRing";
import { WeekChart } from "@/components/review/WeekChart";

export default function ReviewPage() {
  const { data: stats, isLoading: statsLoading } = useSWR<StatsSummary>(keys.stats(), fetcher);
  const {
    data: reviewData,
    error: reviewError,
    isLoading: reviewLoading,
    mutate: mutateReview,
  } = useSWR<{ review: WeeklyReview }>(keys.review(), fetcher);

  const [dismissed, setDismissed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const week = stats?.week ?? [];
  const doneThisWeek = week.reduce((sum, d) => sum + d.done, 0);
  const review = reviewData?.review;
  const needsAi = reviewError instanceof ApiError && reviewError.status === 409;

  const refresh = async () => {
    setRefreshing(true);
    try {
      const next = await assistantApi.review(true);
      await mutateReview(next, { revalidate: false });
    } catch {
      await mutateReview();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Your week"
        subtitle={review ? weekRangeLabel(review.weekKey) : "How things have been going."}
      />

      <section className="card mb-4 flex flex-col items-center gap-4 p-6 sm:flex-row sm:gap-8">
        {statsLoading ? (
          <Skeleton className="h-[148px] w-[148px] rounded-full" />
        ) : (
          <StreakRing days={stats?.streakDays ?? 0} />
        )}
        <div className="grid w-full flex-1 grid-cols-3 gap-2">
          <StatTile label="Done this week" value={doneThisWeek} loading={statsLoading} />
          <StatTile label="Open now" value={stats?.totalOpen ?? 0} loading={statsLoading} />
          <StatTile label="Overdue now" value={stats?.overdue ?? 0} loading={statsLoading} tone="warn" />
        </div>
      </section>

      <section className="card mb-4 p-5">
        <h2 className="mb-1 text-[15px] font-semibold tracking-tight text-ink">
          Tasks completed each day
        </h2>
        <p className="mb-3 text-[13px] text-muted">
          {doneThisWeek === 0
            ? "No completions logged in the last seven days."
            : `${doneThisWeek} in the last seven days.`}
        </p>
        {statsLoading ? (
          <Skeleton className="h-[136px] w-full rounded-2xl" />
        ) : (
          <WeekChart week={week} />
        )}
      </section>

      {needsAi ? (
        dismissed ? null : (
          <AiNudge onDismiss={() => setDismissed(true)} what="weekly review" />
        )
      ) : reviewLoading && !review ? (
        <div className="card space-y-2.5 p-5">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-5/6" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      ) : review ? (
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="card p-5"
        >
          <div className="mb-2 flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-full bg-accent-soft text-accent">
              <IconSparkles className="h-3.5 w-3.5" />
            </span>
            <h2 className="flex-1 text-[13px] font-semibold uppercase tracking-[0.08em] text-faint">
              Reflection
            </h2>
            <IconButton label="Regenerate review" size="sm" onClick={refresh} disabled={refreshing}>
              <IconRefresh className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            </IconButton>
          </div>

          <p className="text-[15px] leading-relaxed text-ink">{review.narrative}</p>

          {review.bestDay ? (
            <p className="mt-3 text-[13px] text-muted">
              Best day: <span className="font-medium text-ink">{review.bestDay}</span>
            </p>
          ) : null}

          {review.suggestions?.length ? (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {review.suggestions.map((s, i) => (
                <span
                  key={`${s}-${i}`}
                  className="rounded-full bg-accent-soft px-3 py-1.5 text-[13px] font-medium text-accent"
                >
                  {s}
                </span>
              ))}
            </div>
          ) : null}
        </motion.section>
      ) : null}
    </Page>
  );
}

function StatTile({
  label,
  value,
  loading,
  tone = "default",
}: {
  label: string;
  value: number;
  loading?: boolean;
  tone?: "default" | "warn";
}) {
  return (
    <div className="rounded-2xl border border-stroke bg-sunken px-3 py-3 text-center">
      {loading ? (
        <Skeleton className="mx-auto h-7 w-10" />
      ) : (
        <div
          className={
            tone === "warn" && value > 0
              ? "text-[26px] font-semibold leading-none text-warn"
              : "text-[26px] font-semibold leading-none text-ink"
          }
        >
          {value}
        </div>
      )}
      <div className="mt-1.5 text-[11.5px] leading-tight text-muted">{label}</div>
    </div>
  );
}
