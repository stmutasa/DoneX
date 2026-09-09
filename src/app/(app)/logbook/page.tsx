"use client";

import { useEffect, useState } from "react";
import { ApiError, logbookApi, tasksApi } from "@/lib/api";
import type { LogbookDay } from "@/lib/types";
import { dayHeading, timeLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Page } from "@/components/shell/Page";
import { EmptyState, PageHeader, SkeletonRows } from "@/components/ui/Misc";
import { useToast } from "@/components/ui/Toast";
import { IconCheck } from "@/components/ui/icons";

/** Entries are keyed by task + moment, since a repeat is logged many times. */
const entryKey = (taskId: string, completedAt: string) => `${taskId}-${completedAt}`;

export default function LogbookPage() {
  const toast = useToast();
  const [days, setDays] = useState<LogbookDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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

  const dropEntry = (taskId: string, completedAt: string) =>
    setDays((prev) =>
      prev
        .map((d) => ({
          ...d,
          entries: d.entries.filter((e) => entryKey(e.taskId, e.completedAt) !== entryKey(taskId, completedAt)),
        }))
        .filter((d) => d.entries.length > 0),
    );

  /** Untick a logged completion: the task goes back on the open list. */
  const restore = async (taskId: string, title: string, completedAt: string) => {
    const key = entryKey(taskId, completedAt);
    if (busy) return;
    setBusy(key);
    try {
      const { task } = await tasksApi.complete(taskId, false);
      dropEntry(taskId, completedAt);
      toast.success(
        task.recurrence
          ? `Removed from the log — “${title}” keeps its next date`
          : `“${title}” is back on your list`,
      );
    } catch (err) {
      // The task itself may have been deleted since; the log entry outlives it.
      if (err instanceof ApiError && err.status === 404) {
        toast.error("That task no longer exists, so there's nothing to restore");
      } else {
        toast.error(err instanceof Error ? err.message : "Could not restore that");
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Logbook"
        subtitle="Everything you’ve finished, day by day. Tap a tick to put one back."
      />

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
              {day.entries.map((entry) => {
                const key = entryKey(entry.taskId, entry.completedAt);
                return (
                  <li
                    key={key}
                    className={cn(
                      "flex min-h-[44px] items-center gap-3 rounded-2xl border border-stroke bg-elev px-3 py-2.5 transition-opacity",
                      busy === key && "opacity-50",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => void restore(entry.taskId, entry.title, entry.completedAt)}
                      disabled={busy !== null}
                      aria-label={`Restore “${entry.title}” to your list`}
                      title="Put this back on your list"
                      className="group -m-2 grid h-11 w-11 shrink-0 place-items-center rounded-full"
                    >
                      <span className="grid h-[22px] w-[22px] place-items-center rounded-full bg-sunrise text-on-accent transition-colors group-hover:bg-transparent group-hover:text-transparent group-hover:ring-2 group-hover:ring-inset group-hover:ring-stroke-strong">
                        <IconCheck className="h-3 w-3" strokeWidth={3} />
                      </span>
                    </button>
                    <span className="min-w-0 flex-1 text-[15px] leading-snug text-ink">
                      {entry.title}
                    </span>
                    <span className="shrink-0 text-[12px] text-faint">
                      {timeLabel(entry.completedAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}
    </Page>
  );
}
