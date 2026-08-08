"use client";

import { useState } from "react";
import useSWR from "swr";
import { AnimatePresence, motion } from "framer-motion";
import { ApiError, assistantApi, fetcher, keys } from "@/lib/api";
import type { DayPlan, GoogleStatus, PlanBlock, Task } from "@/lib/types";
import { clockLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button, IconButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { IconCheck, IconRefresh, IconWand } from "@/components/ui/icons";
import { AiNudge } from "@/components/today/AiNudge";

const KIND_TONE: Record<PlanBlock["kind"], string> = {
  focus: "bg-sunrise",
  break: "bg-ok",
  errand: "bg-warn",
  event: "bg-accent",
};

export function PlanStrip({ tasks }: { tasks: Task[] }) {
  const toast = useToast();
  const { data: google } = useSWR<GoogleStatus>(keys.googleStatus(), fetcher);
  const [plan, setPlan] = useState<DayPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [addToCalendar, setAddToCalendar] = useState(false);
  const [needsAi, setNeedsAi] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  const generate = async (refresh: boolean) => {
    setLoading(true);
    try {
      const res = await assistantApi.plan(refresh);
      setPlan(res.plan);
      setCollapsed(res.plan.accepted);
      setNeedsAi(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setNeedsAi(true);
      else toast.error(err instanceof Error ? err.message : "Could not build a plan");
    } finally {
      setLoading(false);
    }
  };

  const accept = async () => {
    if (!plan) return;
    setAccepting(true);
    try {
      const res = await assistantApi.acceptPlan(plan.blocks, addToCalendar);
      setPlan(res.plan);
      setCollapsed(true);
      toast.success(addToCalendar ? "Plan accepted and added to calendar" : "Plan accepted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not accept the plan");
    } finally {
      setAccepting(false);
    }
  };

  if (needsAi) return <AiNudge onDismiss={() => setNeedsAi(false)} what="day plan" />;

  if (!plan) {
    return (
      <button
        type="button"
        onClick={() => generate(false)}
        disabled={loading}
        className="flex w-full items-center gap-3 rounded-2xl border border-dashed border-stroke-strong bg-elev/60 px-4 py-3 text-left transition-colors hover:border-accent disabled:opacity-60"
      >
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
          <IconWand className="h-[18px] w-[18px]" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium text-ink">
            {loading ? "Shaping your day…" : "Plan my day"}
          </span>
          <span className="block text-[13px] text-muted">
            Let DoneX block out time for what matters.
          </span>
        </span>
      </button>
    );
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        className="flex w-full items-center gap-2.5 rounded-full border border-stroke bg-elev px-4 py-2.5 text-left"
      >
        <span className="grid h-5 w-5 place-items-center rounded-full bg-sunrise text-on-accent">
          <IconCheck className="h-3 w-3" strokeWidth={3} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
          Day plan ready · {plan.blocks.length} blocks
        </span>
        <span className="text-[13px] font-medium text-accent">View</span>
      </button>
    );
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="card overflow-hidden"
    >
      <div className="flex items-start gap-3 p-4 pb-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
          <IconWand className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">
            {plan.accepted ? "Your day" : "Suggested day"}
          </h2>
          {plan.summary ? (
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{plan.summary}</p>
          ) : null}
        </div>
        <IconButton
          label="Reshuffle plan"
          size="sm"
          onClick={() => generate(true)}
          disabled={loading}
        >
          <IconRefresh className={cn("h-4 w-4", loading && "animate-spin")} />
        </IconButton>
      </div>

      <ol className="space-y-1.5 px-4 pb-3">
        <AnimatePresence initial={false}>
          {plan.blocks.map((block, i) => {
            const linked = block.taskIds
              .map((id) => tasks.find((t) => t.id === id)?.title)
              .filter((t): t is string => !!t);
            return (
              <motion.li
                key={`${block.start}-${i}`}
                layout
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className="flex gap-3 rounded-xl bg-sunken px-3 py-2.5"
              >
                <span className="w-[92px] shrink-0 pt-0.5 text-[12px] font-medium tabular-nums text-muted">
                  {clockLabel(block.start)}
                  <span className="block text-faint">{clockLabel(block.end)}</span>
                </span>
                <span className={cn("mt-1 h-auto w-1 shrink-0 rounded-full", KIND_TONE[block.kind])} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] text-ink">{block.label}</span>
                  {linked.length ? (
                    <span className="mt-0.5 block truncate text-[12px] text-faint">
                      {linked.join(" · ")}
                    </span>
                  ) : null}
                </span>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ol>

      {!plan.accepted ? (
        <div className="space-y-3 border-t border-stroke px-4 py-3">
          {google?.connected ? (
            <label className="flex items-center justify-between gap-3 text-[13px] text-muted">
              Add blocks to Google Calendar
              <Switch
                label="Add blocks to Google Calendar"
                checked={addToCalendar}
                onChange={setAddToCalendar}
              />
            </label>
          ) : null}
          <div className="flex gap-2">
            <Button block onClick={() => generate(true)} disabled={loading}>
              Reshuffle
            </Button>
            <Button block variant="primary" loading={accepting} onClick={accept}>
              Accept plan
            </Button>
          </div>
        </div>
      ) : (
        <div className="border-t border-stroke px-4 py-2.5">
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="text-[13px] font-medium text-accent"
          >
            Collapse
          </button>
        </div>
      )}
    </motion.section>
  );
}
