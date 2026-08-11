"use client";

import { useEffect, useState } from "react";
import { logbookApi } from "@/lib/api";
import type { LogbookDay } from "@/lib/types";
import { dayHeading, timeLabel } from "@/lib/format";
import { Page } from "@/components/shell/Page";
import { EmptyState, PageHeader, SkeletonRows } from "@/components/ui/Misc";
import { IconCheck } from "@/components/ui/icons";

export default function LogbookPage() {
  const [days, setDays] = useState<LogbookDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    logbookApi
      .list(60)
      .then((res) => {
        if (cancelled) return;
        setDays(res.days.filter((d) => d.entries.length > 0));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load your logbook");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Page>
      <PageHeader title="Logbook" subtitle="Everything you’ve finished, day by day." />

      {error && !loading ? (
        <p className="mb-4 rounded-2xl border border-danger/30 bg-danger/10 p-3.5 text-[13px] leading-relaxed text-danger">
          {error}
        </p>
      ) : null}

      {loading ? (
        <SkeletonRows rows={5} />
      ) : days.length === 0 ? (
        <EmptyState
          emoji="🌱"
          title="Nothing completed yet"
          message="Finished tasks will build your history here."
        />
      ) : (
        days.map((day) => (
          <section key={day.dateLocal} className="mb-6">
            <div className="mb-2 flex items-center gap-2 px-1">
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.08em] text-muted">
                {dayHeading(day.dateLocal)}
              </h2>
              <span className="text-[12px] font-medium text-faint">{day.entries.length}</span>
            </div>

            <ul className="space-y-1.5">
              {day.entries.map((entry) => (
                <li
                  key={`${entry.taskId}-${entry.completedAt}`}
                  className="flex min-h-[44px] items-center gap-3 rounded-2xl border border-stroke bg-elev px-3 py-2.5"
                >
                  <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full bg-sunrise text-on-accent">
                    <IconCheck className="h-3 w-3" strokeWidth={3} />
                  </span>
                  <span className="min-w-0 flex-1 text-[15px] leading-snug text-ink">
                    {entry.title}
                  </span>
                  <span className="shrink-0 text-[12px] text-faint">
                    {timeLabel(entry.completedAt)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </Page>
  );
}
