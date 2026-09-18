/**
 * The rules about which model belongs to which provider.
 *
 * A model id only means something to the provider it came from, so these keep
 * each provider's choice with that provider, and keep the backup from quietly
 * pointing at the very provider it is supposed to stand in for. Pure, so the
 * settings route and the save-and-test route can't drift apart.
 */
import type { AIProviderKind, AISettings } from "@/lib/types";

export type AiPatch = Partial<AISettings>;

/** Where a provider's chosen model is parked while another one is active. */
export function rememberModel(provider: AIProviderKind, model: string): AiPatch {
  if (provider === "openai") return { openaiModel: model };
  if (provider === "anthropic") return { anthropicModel: model };
  return { customModel: model };
}

/** What that provider was last set to — "" means auto-pick its newest. */
export function recallModel(provider: AIProviderKind, ai: AISettings): string {
  if (provider === "openai") return ai.openaiModel;
  if (provider === "anthropic") return ai.anthropicModel;
  return ai.customModel;
}

/**
 * What a requested change to the AI settings should actually write.
 *
 * Two things it will not let happen: a model id following you from the
 * provider that understood it to one that doesn't, and a backup provider
 * equal to the active one — which does nothing at all, because failover
 * skips a standby that is already the thing that just failed.
 */
export function resolveAiPatch(current: AISettings, patch: AiPatch): AiPatch {
  const next: AiPatch = { ...patch };

  if (patch.provider !== undefined && patch.provider !== current.provider) {
    Object.assign(next, rememberModel(current.provider, current.model));
    // A model named in the same breath as the provider is a deliberate choice
    // and outranks whatever that provider was last set to.
    const chosen = patch.model !== undefined ? patch.model : recallModel(patch.provider, current);
    next.model = chosen;
    Object.assign(next, rememberModel(patch.provider, chosen));
  } else if (patch.model !== undefined) {
    Object.assign(next, rememberModel(current.provider, patch.model));
  }

  const provider = next.provider ?? current.provider;
  const fallback = next.fallbackProvider ?? current.fallbackProvider;
  if (fallback && fallback === provider) {
    next.fallbackProvider = "";
    next.fallbackModel = "";
  }

  return next;
}

/** True when the backup would be dropped by the change above. */
export function backupCollides(current: AISettings, patch: AiPatch): boolean {
  const provider = patch.provider ?? current.provider;
  const fallback = patch.fallbackProvider ?? current.fallbackProvider;
  return !!fallback && fallback === provider;
}
