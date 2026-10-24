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
  | "jointDigest"
  | "weekAhead"
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
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
}): void {
  const n = (v: number | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const input = n(entry.inputTokens);
  const output = n(entry.outputTokens);
  if (input <= 0 && output <= 0) return;

  try {
    const tz = settingsRepo.getApp().tz;
    usageRepo.add({
      provider: entry.provider,
      model: entry.model,
      feature: entry.feature || "other",
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: Math.min(n(entry.cachedInputTokens), input),
      cacheWriteTokens: n(entry.cacheWriteTokens),
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

export interface ReadUsage {
  /** every input token the call was billed for, cached or not */
  inputTokens: number;
  outputTokens: number;
  /** of those, how many were served from the provider's prompt cache */
  cachedInputTokens: number;
  /** how many were written into the cache (Anthropic bills these at a premium) */
  cacheWriteTokens: number;
}

/**
 * Pull token counts out of whatever shape the provider reported, on one scale.
 *
 * The two disagree about what "input" means. OpenAI's prompt_tokens is the
 * whole prompt, with the cached part broken out inside it. Anthropic's
 * input_tokens is only the part that was neither read from nor written to
 * the cache — so once caching works, it alone would make the token tracker
 * undercount wildly. Here input always means the whole prompt.
 */
export function readUsage(raw: unknown): ReadUsage {
  const rec = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  if (rec.prompt_tokens !== undefined || rec.completion_tokens !== undefined) {
    const details = (rec.prompt_tokens_details ?? {}) as Record<string, unknown>;
    return {
      inputTokens: num(rec.prompt_tokens),
      outputTokens: num(rec.completion_tokens),
      cachedInputTokens: num(details.cached_tokens),
      cacheWriteTokens: 0,
    };
  }

  const read = num(rec.cache_read_input_tokens);
  const written = num(rec.cache_creation_input_tokens);
  return {
    inputTokens: num(rec.input_tokens) + read + written,
    outputTokens: num(rec.output_tokens),
    cachedInputTokens: read,
    cacheWriteTokens: written,
  };
}
