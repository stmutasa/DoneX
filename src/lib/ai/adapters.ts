import { settingsRepo } from "@/lib/db/repos";
import { nowIso } from "@/lib/utils";
import type { AiFallbackEvent, AIProviderKind, ModelInfo } from "@/lib/types";
import { anthropicAdapter } from "@/lib/ai/anthropic";
import { openaiAdapter } from "@/lib/ai/openai";
import {
  NOT_CONFIGURED,
  NO_MODEL,
  configReady,
  describeCallError,
  resolveConfig,
  type ProviderAdapter,
  type ProviderConfig,
} from "@/lib/ai/provider";

export function adapterFor(kind: AIProviderKind): ProviderAdapter {
  return kind === "anthropic" ? anthropicAdapter : openaiAdapter;
}

/** Active-provider config guaranteed to carry both a key and a model id. */
export async function readyConfig(): Promise<ProviderConfig> {
  const cfg = resolveConfig();
  if (!configReady(cfg)) throw new Error(NOT_CONFIGURED);
  if (cfg.model) return cfg;
  await autoPickModelIfNeeded();
  const next = resolveConfig();
  if (!next.model) throw new Error(NO_MODEL);
  return next;
}

export function aiConfigured(): boolean {
  return configReady(resolveConfig());
}

// ── Failover ───────────────────────────────────────────────────────────────

const FALLBACK_KEY = "ai.lastFallback";

/** The standby provider, or null when none is usable. */
export function fallbackConfig(): ProviderConfig | null {
  const ai = settingsRepo.getApp().ai;
  const kind = ai.fallbackProvider;
  if (!kind || kind === ai.provider) return null;
  const cfg = resolveConfig(kind);
  const model = ai.fallbackModel.trim() || cfg.model;
  if (!configReady(cfg) || !model) return null;
  return { ...cfg, model };
}

/** Config problems can't be fixed by trying elsewhere; everything else can. */
export function isFailoverWorthy(message: string): boolean {
  return message !== NOT_CONFIGURED && message !== NO_MODEL;
}

export function recordFallback(from: AIProviderKind, to: ProviderConfig, reason: string): void {
  const event: AiFallbackEvent = {
    at: nowIso(),
    from,
    to: to.kind,
    model: to.model,
    reason: reason.slice(0, 300),
  };
  try {
    settingsRepo.setKV(FALLBACK_KEY, JSON.stringify(event));
  } catch {
    // Telling the user is a bonus; never fail the call over it.
  }
}

export function lastFallbackEvent(): AiFallbackEvent | null {
  try {
    const raw = settingsRepo.getKV(FALLBACK_KEY);
    return raw ? (JSON.parse(raw) as AiFallbackEvent) : null;
  } catch {
    return null;
  }
}

/**
 * Run an AI call against the active provider, and if it fails for any reason
 * the standby could plausibly fix, run it again there. Keeps the app working
 * through an expired key, a rate limit or a provider outage.
 */
export async function callWithFailover<T>(
  run: (cfg: ProviderConfig, adapter: ProviderAdapter) => Promise<T>,
): Promise<T> {
  const primary = await readyConfig();
  try {
    return await run(primary, adapterFor(primary.kind));
  } catch (err) {
    const reason = describeCallError(err);
    const backup = fallbackConfig();
    if (!backup || !isFailoverWorthy(reason)) throw err;
    try {
      const value = await run(backup, adapterFor(backup.kind));
      recordFallback(primary.kind, backup, reason);
      return value;
    } catch (backupErr) {
      throw new Error(
        `${reason} — and the ${backup.kind} fallback (${backup.model}) also failed: ${describeCallError(backupErr)}`,
      );
    }
  }
}

export async function listModels(provider: AIProviderKind): Promise<ModelInfo[]> {
  const cfg = resolveConfig(provider);
  if (!configReady(cfg)) throw new Error(NOT_CONFIGURED);
  return adapterFor(cfg.kind).models(cfg);
}

export async function testProvider(
  provider: AIProviderKind
): Promise<{ ok: boolean; message: string }> {
  try {
    const cfg = resolveConfig(provider);
    if (!configReady(cfg)) return { ok: false, message: NOT_CONFIGURED };

    let model = cfg.model;
    if (!model) {
      const models = await adapterFor(cfg.kind).models(cfg);
      model = models[0]?.id ?? "";
      if (!model) return { ok: false, message: "The provider returned no usable models." };
    }

    const text = await adapterFor(cfg.kind).complete({
      cfg: { ...cfg, model },
      system: "You are a connectivity probe. Answer with one word.",
      prompt: "Reply with the single word: ok",
      maxTokens: 8,
      signal: AbortSignal.timeout(30_000),
    });
    if (!text.trim()) return { ok: false, message: `${model} returned an empty reply.` };
    return { ok: true, message: `${model} responded` };
  } catch (err) {
    return { ok: false, message: describeCallError(err) };
  }
}

/** Picks the newest sensible model when none is set. Never throws. */
export async function autoPickModelIfNeeded(): Promise<void> {
  try {
    const ai = settingsRepo.getApp().ai;
    const cfg = resolveConfig(ai.provider);
    if (!configReady(cfg)) return;
    const current = ai.provider === "custom" ? ai.customModel.trim() : ai.model.trim();
    if (current) return;
    const models = await adapterFor(cfg.kind).models(cfg);
    const first = models[0];
    if (!first) return;
    settingsRepo.updateApp(
      ai.provider === "custom"
        ? { ai: { customModel: first.id, model: first.id } }
        : { ai: { model: first.id } }
    );
  } catch {
    // best effort — settings PATCH and scheduler ticks must not fail on this
  }
}
