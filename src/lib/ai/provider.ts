import { settingsRepo } from "@/lib/db/repos";
import type { AIProviderKind, AISettings, ModelInfo } from "@/lib/types";
import { asRecord, asString, safeJsonParse } from "@/lib/ai/json";
import type { ToolSpec } from "@/lib/ai/tools";

export const OPENAI_BASE = "https://api.openai.com/v1";
export const ANTHROPIC_BASE = "https://api.anthropic.com/v1";
/** Gemini's OpenAI-compatible endpoint, so the OpenAI adapter speaks to it as-is. */
export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
export const ANTHROPIC_VERSION = "2023-06-01";
export const CALL_TIMEOUT_MS = 90_000;

export const NOT_CONFIGURED = "No AI provider configured — add its API key in Railway → Variables.";
export const NO_MODEL = "No model selected — choose one in Settings.";
/** An empty reply cut off at the token cap: the budget went on thinking. */
export const OUT_OF_TOKENS = "The model ran out of tokens before it answered.";

/**
 * Room for the thinking a reasoning model does before it answers, on top of
 * the cap sized for the answer. Only what is generated is billed, so the extra
 * room costs nothing unless it is used.
 */
export const REASONING_HEADROOM = 4096;

export interface ProviderConfig {
  kind: AIProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function stripTrailingSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * The environment variable each provider's key is read from. Keys live in
 * Railway's service variables, not in the app's database: they never pass
 * through the browser, never land in a backup, and can't be cleared by a
 * stray tap in Settings.
 */
export const KEY_ENV: Record<AIProviderKind, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  custom: "CUSTOM_AI_API_KEY",
};

/** A key saved in the app by an older version — honoured only until Railway has one. */
function storedKey(kind: AIProviderKind, ai: AISettings): string {
  if (kind === "openai") return ai.openaiKey.trim();
  if (kind === "anthropic") return ai.anthropicKey.trim();
  if (kind === "custom") return ai.customKey.trim();
  return "";
}

/** Where a provider's key comes from: Railway first, then an older stored copy. */
export function keyFor(
  kind: AIProviderKind,
  ai: AISettings = settingsRepo.getApp().ai,
): { key: string; source: "env" | "stored" | "none"; storedCopy: boolean } {
  const env = (process.env[KEY_ENV[kind]] ?? "").trim();
  const stored = storedKey(kind, ai);
  if (env) return { key: env, source: "env", storedCopy: !!stored };
  if (stored) return { key: stored, source: "stored", storedCopy: true };
  return { key: "", source: "none", storedCopy: false };
}

/** Resolve wire config for a provider; defaults to the active provider. */
export function resolveConfig(kind?: AIProviderKind): ProviderConfig {
  const ai = settingsRepo.getApp().ai;
  const target = kind ?? ai.provider;
  const isActive = target === ai.provider;
  const apiKey = keyFor(target, ai).key;
  if (target === "anthropic") {
    return { kind: "anthropic", baseUrl: ANTHROPIC_BASE, apiKey, model: isActive ? ai.model.trim() : "" };
  }
  if (target === "gemini") {
    return { kind: "gemini", baseUrl: GEMINI_BASE, apiKey, model: isActive ? ai.model.trim() : "" };
  }
  if (target === "custom") {
    return {
      kind: "custom",
      baseUrl: stripTrailingSlash(ai.customBaseUrl),
      apiKey,
      model: ai.customModel.trim() || (isActive ? ai.model.trim() : ""),
    };
  }
  return { kind: "openai", baseUrl: OPENAI_BASE, apiKey, model: isActive ? ai.model.trim() : "" };
}

export function configReady(cfg: ProviderConfig): boolean {
  if (!cfg.apiKey) return false;
  if (cfg.kind === "custom" && !cfg.baseUrl) return false;
  return true;
}

// ── Unified conversation shape ─────────────────────────────────────────────

export interface LlmToolCall {
  id: string;
  name: string;
  /** raw JSON argument string as streamed by the provider */
  args: string;
  /**
   * Provider data that has to go back with the call on the next request —
   * Gemini's thought signature, sent as `extra_content`. Opaque; echoed as is,
   * and only to `origin`.
   */
  extraContent?: Record<string, unknown>;
  /** the provider that made this call */
  origin?: AIProviderKind;
}

export interface LlmToolResult {
  id: string;
  name: string;
  content: string;
}

export type LlmTurn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: LlmToolCall[] }
  | { role: "toolResults"; results: LlmToolResult[] };

export interface StreamArgs {
  cfg: ProviderConfig;
  system: string;
  turns: LlmTurn[];
  tools: ToolSpec[];
  onText: (text: string) => void;
  signal: AbortSignal;
  /** what the tokens are being spent on, for the Usage screen */
  feature?: string;
}

export interface StreamOutcome {
  text: string;
  toolCalls: LlmToolCall[];
}

export interface CompleteArgs {
  cfg: ProviderConfig;
  system: string;
  /**
   * Stable text that many calls share, most stable first. It is sent ahead of
   * `prompt` — which should carry only what differs per call — so providers
   * can serve it from their prompt cache instead of billing it at full price
   * every time. Anthropic is told to cache it explicitly; OpenAI caches any
   * repeated prefix on its own, which this ordering is what makes possible.
   */
  shared?: string[];
  prompt: string;
  maxTokens: number;
  signal: AbortSignal;
  /** what the tokens are being spent on, for the Usage screen */
  feature?: string;
}

export interface ProviderAdapter {
  stream(args: StreamArgs): Promise<StreamOutcome>;
  complete(args: CompleteArgs): Promise<string>;
  models(cfg: ProviderConfig): Promise<ModelInfo[]>;
}

// ── Errors ─────────────────────────────────────────────────────────────────

/** Surface the provider's own wording — "invalid model", "invalid api key". */
export function cleanProviderMessage(status: number, raw: string): string {
  const trimmed = raw.trim();
  if (trimmed) {
    const picked = pickMessage(safeJsonParse(trimmed));
    if (picked) return picked;
    if (trimmed.length <= 400 && !trimmed.startsWith("<")) return trimmed;
  }
  if (status === 401 || status === 403) return `Provider rejected the API key (HTTP ${status})`;
  if (status === 429) return "Provider rate limit reached (HTTP 429)";
  return `Provider request failed (HTTP ${status})`;
}

function pickMessage(value: unknown): string | null {
  // Gemini's OpenAI-compatible endpoint wraps its error in a one-item array.
  if (Array.isArray(value)) return value.length > 0 ? pickMessage(value[0]) : null;
  const rec = asRecord(value);
  if (!rec) return null;
  const err = rec.error;
  if (typeof err === "string" && err.trim()) return err.trim();
  const errRec = asRecord(err);
  if (errRec) {
    const msg = asString(errRec.message);
    if (msg && msg.trim()) return msg.trim();
    const type = asString(errRec.type);
    if (type && type.trim()) return type.trim();
  }
  for (const key of ["message", "detail", "error_message"]) {
    const v = asString(rec[key]);
    if (v && v.trim()) return v.trim();
  }
  return null;
}

export async function providerError(res: Response): Promise<Error> {
  let raw = "";
  try {
    raw = await res.text();
  } catch {
    raw = "";
  }
  return new Error(cleanProviderMessage(res.status, raw));
}

export function describeCallError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return "The AI provider took too long to respond.";
    }
    return err.message || "Unexpected AI provider error.";
  }
  return "Unexpected AI provider error.";
}

export function timeoutSignal(): AbortSignal {
  return AbortSignal.timeout(CALL_TIMEOUT_MS);
}
