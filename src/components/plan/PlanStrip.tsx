"use client";

import { useState } from "react";
import useSWR from "swr";
import { AnimatePresence, motion } from "framer-motion";
import { ApiError, assistantApi, fetcher, keys } from "@/lib/api";
import type { DayPlan, GoogleStatus, MaskedSettings, PlanBlock, Task } from "@/lib/types";
import { clockLabel, dateKey, dayHeading } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useTTS } from "@/hooks/useTTS";
import { Button, IconButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { IconCheck, IconRefresh, IconStop, IconVolume, IconWand } from "@/components/ui/icons";
import { AiNudge } from "@/components/today/AiNudge";

const KIND_TONE: Record<PlanBlock["kind"], string> = {
  focus: "bg-sunrise",
  break: "bg-ok",
  errand: "bg-warn",
  event: "bg-accent",
};

/** Natural narration of the plan for the read-aloud button. */
function spokenPlan(plan: DayPlan): string {
  const parts: string[] = [];
  if (plan.summary) parts.push(plan.summary);
  for (const block of plan.blocks) {
    const est =
      block.kind === "break" || block.kind === "event" || !block.estimateMin
        ? ""
        : `, about ${block.estimateMin} minutes`;
    parts.push(`At ${clockLabel(block.start)}: ${block.label}${est}.`);
  }
  return parts.join(" ");
}

export function PlanStrip({ tasks }: { tasks: Task[] }) {
  const toast = useToast();
  const tts = useTTS();
  const { data: google } = useSWR<GoogleStatus>(keys.googleStatus(), fetcher);
  const { data: settings } = useSWR<MaskedSettings>(keys.settings(), fetcher);
  const { data: stored, mutate: mutateStored } = useSWR<{ plan: DayPlan | null }>(
    keys.plan(),
    fetcher,
  );

  const [override, setOverride] = useState<DayPlan | null>(null);
  const [loading, setLoading] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [addToCalendar, setAddToCalendar] = useState(false);
  const [needsAi, setNeedsAi] = useState(false);
  const [collapsedChoice, setCollapsedChoice] = useState<boolean | null>(null);

  const plan = override ?? stored?.plan ?? null;
  const stale = !!plan && plan.dateLocal < dateKey();
  // Accepted plans start out as the quiet pill; anything else stays visible.
  const collapsed = collapsedChoice ?? (!!plan && plan.accepted);

  const generate = async (refresh: boolean) => {
    setLoading(true);
    tts.cancel();
    try {
      const res = await assistantApi.plan(refresh);
      setOverride(res.plan);
      void mutateStored({ plan: res.plan }, false);
      setCollapsedChoice(res.plan.accepted);
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
      setOverride(res.plan);
      void mutateStored({ plan: res.plan }, false);
      setCollapsedChoice(true);
      toast.success(addToCalendar ? "Plan accepted and added to calendar" : "Plan accepted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not accept the plan");
    } finally {
      setAccepting(false);
    }
  };

  const toggleSpeak = () => {
    if (!plan) return;
    if (tts.speaking) {
      tts.cancel();
      return;
    }
    tts.speak(spokenPlan(plan), {
      voiceURI: settings?.voice.voiceURI || undefined,
      rate: settings?.voice.rate ?? 1,
    });
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
            Let DoneX pick what to work on and block out the time.
          </span>
        </span>
      </button>
    );
  }

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsedChoice(false)}
        className="flex w-full items-center gap-2.5 rounded-full border border-stroke bg-elev px-4 py-2.5 text-left"
      >
        <span className="grid h-5 w-5 place-items-center rounded-full bg-sunrise text-on-accent">
          <IconCheck className="h-3 w-3" strokeWidth={3} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
          {stale
            ? `${dayHeading(plan.dateLocal)}’s plan · ${plan.blocks.length} blocks`
            : `Day plan ready · ${plan.blocks.length} blocks`}
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
            {stale
              ? `${dayHeading(plan.dateLocal)}’s plan`
              : plan.accepted
                ? "Your day"
                : "Suggested day"}
          </h2>
          {plan.summary ? (
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{plan.summary}</p>
          ) : null}
        </div>
        {tts.supported ? (
          <IconButton
            label={tts.speaking ? "Stop reading" : "Read the plan aloud"}
            size="sm"
            onClick={toggleSpeak}
            className={cn(tts.speaking && "text-accent")}
          >
            {tts.speaking ? (
              <IconStop className="h-4 w-4" />
            ) : (
              <IconVolume className="h-4 w-4" />
            )}
          </IconButton>
        ) : null}
        {!stale ? (
          <IconButton
            label="Reshuffle plan"
            size="sm"
            onClick={() => generate(true)}
            disabled={loading}
          >
            <IconRefresh className={cn("h-4 w-4", loading && "animate-spin")} />
          </IconButton>
        ) : null}
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
                  <span className="block text-[14px] text-ink">
                    {block.label}
                    {block.estimateMin ? (
                      <span className="ml-1.5 rounded-full bg-elev px-1.5 py-0.5 text-[11px] font-medium text-muted">
                        ~{block.estimateMin}m
                      </span>
                    ) : null}
                  </span>
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

      {stale ? (
        <div className="space-y-3 border-t border-stroke px-4 py-3">
          <p className="text-[13px] text-muted">
            This plan is from {dayHeading(plan.dateLocal).toLowerCase()} — it sticks around until
            you make a new one.
          </p>
          <div className="flex gap-2">
            <Button block onClick={() => setCollapsedChoice(true)}>
              Collapse
            </Button>
            <Button block variant="primary" loading={loading} onClick={() => generate(false)}>
              Plan today
            </Button>
          </div>
        </div>
      ) : !plan.accepted ? (
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
            onClick={() => setCollapsedChoice(true)}
            className="text-[13px] font-medium text-accent"
          >
            Collapse
          </button>
        </div>
      )}
    </motion.section>
  );
}
