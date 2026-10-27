import { settingsRepo } from "@/lib/db/repos";
import { localDateKey, nowIso } from "@/lib/utils";
import type { AiFallbackEvent, AIProviderKind, ModelInfo } from "@/lib/types";
import { anthropicAdapter } from "@/lib/ai/anthropic";
import { openaiAdapter } from "@/lib/ai/openai";
import {
  NOT_CONFIGURED,
  NO_MODEL,
  OUT_OF_TOKENS,
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

/**
 * Whether any provider can take a call — the active one, or the backup
 * standing in for it. The backup counts: it exists for exactly the moment the
 * active provider can't run, and that includes the active key going missing.
 */
export function aiConfigured(): boolean {
  return configReady(resolveConfig()) || backupUsable();
}

function backupUsable(): boolean {
  const ai = settingsRepo.getApp().ai;
  const kind = ai.fallbackProvider;
  return !!kind && kind !== ai.provider && configReady(resolveConfig(kind));
}

const PROVIDER_NAME: Record<AIProviderKind, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Gemini",
  custom: "Your custom provider",
};

/**
 * The provider that can actually take this call: the active one, or — when it
 * has no key or no model — the backup, along with the plain reason it had to
 * step in. Throws only when neither can run.
 */
export async function workingConfig(): Promise<{ cfg: ProviderConfig; standIn: string | null }> {
  try {
    return { cfg: await readyConfig(), standIn: null };
  } catch (err) {
    const backup = await fallbackConfig();
    if (!backup) throw err;
    const active = PROVIDER_NAME[settingsRepo.getApp().ai.provider];
    const why =
      err instanceof Error && err.message === NO_MODEL
        ? `${active} has no model selected`
        : `${active} has no API key set`;
    return { cfg: backup, standIn: why };
  }
}

// ── Failover ───────────────────────────────────────────────────────────────

const FALLBACK_KEY = "ai.lastFallback";

/**
 * Ask the standby provider what it offers and remember the newest one. Both
 * adapters return their lists newest-first, so the head of the list is the
 * current flagship — no model id for the user to pick or keep up to date.
 * Never throws: on failure the previously stored choice stands.
 */
export async function refreshFallbackModel(): Promise<string> {
  const ai = settingsRepo.getApp().ai;
  const stored = ai.fallbackModel.trim();
  const kind = ai.fallbackProvider;
  if (!kind || kind === ai.provider) return stored;

  // A model you picked yourself is not something to keep moving off. Only an
  // unpinned backup follows the provider's newest.
  const pinned = ai.fallbackModelPinned.trim();
  if (pinned) {
    if (pinned !== stored) settingsRepo.updateApp({ ai: { fallbackModel: pinned } });
    return pinned;
  }

  const cfg = resolveConfig(kind);
  if (!configReady(cfg)) return stored;

  // The custom provider has a model id of its own. Its list is the host's
  // whole catalogue, unfiltered, so the head may not even be a chat model.
  if (cfg.kind === "custom" && cfg.model) {
    if (cfg.model !== stored) settingsRepo.updateApp({ ai: { fallbackModel: cfg.model } });
    return cfg.model;
  }

  try {
    const models = await adapterFor(cfg.kind).models(cfg);
    const newest = models[0]?.id ?? "";
    if (!newest) return stored;
    // The listing takes a moment. If the backup was changed or pinned in the
    // meantime, the answer is not saved over a choice that no longer stands —
    // but what comes back still belongs to `kind`, since a caller may already
    // hold that provider's config.
    const now = settingsRepo.getApp().ai;
    if (now.fallbackProvider !== kind) return newest;
    const pinnedNow = now.fallbackModelPinned.trim();
    if (pinnedNow) return pinnedNow;
    if (newest !== now.fallbackModel.trim()) settingsRepo.updateApp({ ai: { fallbackModel: newest } });
    return newest;
  } catch {
    return stored;
  }
}

/** The standby provider, or null when none is usable. */
export async function fallbackConfig(): Promise<ProviderConfig | null> {
  const ai = settingsRepo.getApp().ai;
  const kind = ai.fallbackProvider;
  if (!kind || kind === ai.provider) return null;
  const cfg = resolveConfig(kind);
  if (!configReady(cfg)) return null;
  // A model you pinned wins outright, so failover can never drift onto the
  // resolved-newest value even if that were left stale. Custom's own model id
  // comes next, ahead of anything resolved from its host's list. The rest
  // covers a key added after the provider was chosen, so the first failover
  // finds a model.
  const model =
    ai.fallbackModelPinned.trim() ||
    (cfg.kind === "custom" ? cfg.model : "") ||
    ai.fallbackModel.trim() ||
    cfg.model ||
    (await refreshFallbackModel());
  if (!model) return null;
  return { ...cfg, model };
}

/**
 * Every failure of the active provider is worth handing to the backup — a
 * missing or rejected key included, which is the case a backup is most for.
 * (This once excluded "no key" and "no model" on the theory that another
 * provider couldn't fix them; it can, and that exclusion left work stranded.)
 */
export function isFailoverWorthy(_message: string): boolean {
  return true;
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
  void alertIfNeedsYou(from, to, reason);
}

const OWNER_FIX =
  /no API key (saved|set)|no model selected|rejected the API key|Incorrect API key|invalid[_ ]api[_ ]key|x-api-key|authentication_error|API key not valid|API key expired|permission_error|does not have permission|permission denied|insufficient permissions|Missing scopes|account_deactivated|has been deactivated|credit balance|reached your specified API usage limits|HTTP 40[13]\b/i;

/**
 * OpenAI's words for an account out of credit. Gemini uses the same words for
 * an ordinary per-minute limit, but points at its rate-limit docs and says
 * when to retry — and that passes on its own.
 */
const OUT_OF_CREDIT = /exceeded your current quota|insufficient_quota/i;
const RATE_LIMITED = /rate[- ]?limit|retry in|per minute|free_tier|RESOURCE_EXHAUSTED/i;

/**
 * Failures a retry won't cure: the key, the model or the account has to be
 * fixed by hand. Matched on the provider's own wording, since only the message
 * gets here (callers rethrow it as a plain Error), and when the provider sends
 * a body the HTTP status is not in it.
 */
export function needsOwner(reason: string): boolean {
  return OWNER_FIX.test(reason) || (OUT_OF_CREDIT.test(reason) && !RATE_LIMITED.test(reason));
}

const KV_KEY_ALERT_DAY = "ai.lastKeyAlertDay";

/**
 * A backup quietly carrying the load is good; doing it for weeks because a key
 * is gone is not. When the cause is one only the owner can fix, say so on
 * their phone — at most once a day.
 */
async function alertIfNeedsYou(from: AIProviderKind, to: ProviderConfig, reason: string): Promise<void> {
  try {
    if (!needsOwner(reason)) return;
    // Your day, not UTC's — which turns over at 20:00 in New York.
    const today = localDateKey(new Date(), settingsRepo.getApp().tz);
    if (settingsRepo.getKV(KV_KEY_ALERT_DAY) === today) return;
    settingsRepo.setKV(KV_KEY_ALERT_DAY, today);
    const { sendPushToAll } = await import("@/lib/push");
    await sendPushToAll(
      {
        title: `${PROVIDER_NAME[from]} needs attention`,
        body: `${reason}. Your backup (${to.model}) is covering until you fix it — keys are set in Railway → Variables.`,
        url: "/settings/ai",
        tag: "ai-key-alert",
      },
      ["owner"],
    );
  } catch {
    // never let an alert break the call it is about
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
  const activeKind = settingsRepo.getApp().ai.provider;
  const start = await workingConfig();

  // The active provider can't run at all, so the backup does the work.
  if (start.standIn) {
    try {
      const value = await run(start.cfg, adapterFor(start.cfg.kind));
      recordFallback(activeKind, start.cfg, start.standIn);
      return value;
    } catch (backupErr) {
      throw new Error(
        `${start.standIn} — and the ${start.cfg.kind} backup (${start.cfg.model}) also failed: ${describeCallError(backupErr)}`,
      );
    }
  }

  const primary = start.cfg;
  try {
    return await run(primary, adapterFor(primary.kind));
  } catch (err) {
    const reason = describeCallError(err);
    const backup = await fallbackConfig();
    if (!backup) throw err;
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

/**
 * Probe a provider with a real call.
 *
 * `modelOverride` matters for the standby: resolveConfig only carries a model
 * for the *active* provider, so without it a backup test would quietly probe
 * that provider's newest model rather than the one failover would actually
 * reach for — and report a pass for a model you never chose.
 */
export async function testProvider(
  provider: AIProviderKind,
  modelOverride?: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const cfg = resolveConfig(provider);
    if (!configReady(cfg)) return { ok: false, message: NOT_CONFIGURED };

    let model = modelOverride?.trim() || cfg.model;
    if (!model) {
      const models = await adapterFor(cfg.kind).models(cfg);
      model = models[0]?.id ?? "";
      if (!model) return { ok: false, message: "The provider returned no usable models." };
    }

    let text: string;
    try {
      text = await adapterFor(cfg.kind).complete({
        cfg: { ...cfg, model },
        system: "You are a connectivity probe. Answer with one word.",
        prompt: "Reply with the single word: ok",
        // Enough for a model that thinks before it speaks to get a word out.
        maxTokens: 256,
        feature: "test",
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      // The key and the model both work, but a probe this small running dry
      // means real calls may too — say so rather than show a plain pass.
      if (err instanceof Error && err.message === OUT_OF_TOKENS) {
        return {
          ok: true,
          message: `${model} responded, but used its whole token budget thinking — replies may come back empty`,
        };
      }
      throw err;
    }
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
