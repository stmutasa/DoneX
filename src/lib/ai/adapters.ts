import { settingsRepo } from "@/lib/db/repos";
import type { AIProviderKind, ModelInfo } from "@/lib/types";
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
