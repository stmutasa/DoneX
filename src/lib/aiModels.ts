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
  if (provider === "gemini") return { geminiModel: model };
  return { customModel: model };
}

/** What that provider was last set to — "" means auto-pick its newest. */
export function recallModel(provider: AIProviderKind, ai: AISettings): string {
  if (provider === "openai") return ai.openaiModel;
  if (provider === "anthropic") return ai.anthropicModel;
  if (provider === "gemini") return ai.geminiModel ?? "";
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
export function resolveAiPatch(current: AISettings, requested: AiPatch): AiPatch {
  // Custom keeps its model in two fields: the Model id box writes customModel,
  // the picker and Save write model. Whichever one moves, the other follows —
  // otherwise the stale one is later written back over the new.
  const patch: AiPatch =
    (requested.provider ?? current.provider) === "custom" &&
    requested.customModel !== undefined &&
    requested.model === undefined
      ? { ...requested, model: requested.customModel }
      : requested;
  const next: AiPatch = { ...patch };

  if (patch.provider !== undefined && patch.provider !== current.provider) {
    // Park what was really in use. For custom that is customModel when set,
    // which an older version could leave out of step with model.
    const outgoing =
      current.provider === "custom" ? current.customModel || current.model : current.model;
    Object.assign(next, rememberModel(current.provider, outgoing));
    // A model named in the same breath as the provider is a deliberate choice
    // and outranks whatever that provider was last set to.
    const chosen = patch.model !== undefined ? patch.model : recallModel(patch.provider, current);
    next.model = chosen;
    Object.assign(next, rememberModel(patch.provider, chosen));
  } else if (patch.model !== undefined) {
    Object.assign(next, rememberModel(current.provider, patch.model));
  }

  // The backup's model belongs to the backup's provider, so changing that
  // provider never carries the old one's model across: the resolved model is
  // reset to the pin named with the change, and with no pin named (or an
  // empty one, which is what Settings sends for auto) back to "newest
  // available" rather than asking the new one for a model it has never heard of.
  if (patch.fallbackProvider !== undefined && patch.fallbackProvider !== current.fallbackProvider) {
    if (patch.fallbackModelPinned === undefined) next.fallbackModelPinned = "";
    next.fallbackModel = (next.fallbackModelPinned ?? "").trim();
  }

  const provider = next.provider ?? current.provider;
  const fallback = next.fallbackProvider ?? current.fallbackProvider;
  if (fallback && fallback === provider) {
    next.fallbackProvider = "";
    next.fallbackModel = "";
    next.fallbackModelPinned = "";
  }

  return next;
}

/** True when the backup would be dropped by the change above. */
export function backupCollides(current: AISettings, patch: AiPatch): boolean {
  const provider = patch.provider ?? current.provider;
  const fallback = patch.fallbackProvider ?? current.fallbackProvider;
  return !!fallback && fallback === provider;
}
