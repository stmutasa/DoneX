"use client";

import { useState } from "react";
import useSWR from "swr";
import { motion } from "framer-motion";
import { ApiError, assistantApi, fetcher, keys } from "@/lib/api";
import type { Briefing, Task } from "@/lib/types";
import { IconButton } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Misc";
import { IconRefresh, IconSparkles } from "@/components/ui/icons";
import { AiNudge } from "./AiNudge";

export function BriefingCard({
  tasks,
  onFocusTask,
}: {
  tasks: Task[];
  onFocusTask?: (task: Task) => void;
}) {
  const { data, error, isLoading, mutate } = useSWR<{ briefing: Briefing }>(
    keys.briefing(),
    fetcher,
  );
  const [dismissed, setDismissed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const notConfigured = error instanceof ApiError && error.status === 409;

  if (notConfigured) {
    return dismissed ? null : <AiNudge onDismiss={() => setDismissed(true)} what="morning briefing" />;
  }
  if (error && !data) return null;

  if (isLoading && !data) {
    return (
      <div className="card space-y-2.5 p-4">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-4/5" />
        <Skeleton className="h-3.5 w-2/3" />
      </div>
    );
  }
  if (!data?.briefing) return null;

  const briefing = data.briefing;
  const focus = briefing.focusTaskIds
    .map((id) => tasks.find((t) => t.id === id))
    .filter((t): t is Task => !!t);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const next = await assistantApi.briefing(true);
      await mutate(next, { revalidate: false });
    } catch {
      await mutate();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="card overflow-hidden p-4"
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-accent-soft text-accent">
          <IconSparkles className="h-3.5 w-3.5" />
        </span>
        <h2 className="flex-1 text-[13px] font-semibold uppercase tracking-[0.08em] text-faint">
          {briefing.greeting || "Your briefing"}
        </h2>
        <IconButton label="Refresh briefing" size="sm" onClick={refresh} disabled={refreshing}>
          <IconRefresh className={refreshing ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
        </IconButton>
      </div>

      <p className="text-[15px] leading-relaxed text-ink">{briefing.narrative}</p>

      {focus.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {focus.map((task) => (
            <button
              key={task.id}
              type="button"
              onClick={() => onFocusTask?.(task)}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1.5 text-[13px] font-medium text-accent transition-transform active:scale-95"
            >
              <span className="truncate">{task.title}</span>
            </button>
          ))}
        </div>
      ) : null}
    </motion.section>
  );
}
