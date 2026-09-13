/**
 * Recording what each AI call cost in tokens.
 *
 * Providers report usage on the response itself, so this is bookkeeping
 * rather than estimation. Recording must never be able to break a call the
 * user is waiting on: everything here swallows its own failures.
 */
import "server-only";
import { settingsRepo, usageRepo } from "@/lib/db/repos";
import { localDateKey } from "@/lib/utils";

/** What the tokens were spent on. Kept short — it is stored per call. */
export type AiFeature =
  | "triage"
  | "briefing"
  | "review"
  | "breakdown"
  | "chat"
  | "test"
  | "other";

/** A year and a month of history, so "last 30 days" is always whole. */
const KEEP_DAYS = 396;
let sinceLastPrune = 0;

export function recordAiUsage(entry: {
  provider: string;
  model: string;
  feature?: string;
  inputTokens: number;
  outputTokens: number;
}): void {
  const input = Number.isFinite(entry.inputTokens) ? entry.inputTokens : 0;
  const output = Number.isFinite(entry.outputTokens) ? entry.outputTokens : 0;
  if (input <= 0 && output <= 0) return;

  try {
    const tz = settingsRepo.getApp().tz;
    usageRepo.add({
      provider: entry.provider,
      model: entry.model,
      feature: entry.feature || "other",
      inputTokens: input,
      outputTokens: output,
      dateLocal: localDateKey(new Date(), tz),
    });

    // Trim occasionally rather than on every call.
    if (++sinceLastPrune >= 200) {
      sinceLastPrune = 0;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - KEEP_DAYS);
      usageRepo.prune(localDateKey(cutoff, tz));
    }
  } catch (err) {
    console.error("[usage] could not record tokens", err);
  }
}

/** Pull {input, output} out of whatever shape the provider reported. */
export function readUsage(raw: unknown): { inputTokens: number; outputTokens: number } {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    // OpenAI: prompt/completion_tokens · Anthropic: input/output_tokens
    inputTokens: num(rec.prompt_tokens) || num(rec.input_tokens),
    outputTokens: num(rec.completion_tokens) || num(rec.output_tokens),
  };
}
