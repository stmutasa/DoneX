import { settingsRepo } from "@/lib/db/repos";
import type { AIProviderKind, ModelInfo } from "@/lib/types";
import { asRecord, asString, safeJsonParse } from "@/lib/ai/json";
import type { ToolSpec } from "@/lib/ai/tools";

export const OPENAI_BASE = "https://api.openai.com/v1";
export const ANTHROPIC_BASE = "https://api.anthropic.com/v1";
export const ANTHROPIC_VERSION = "2023-06-01";
export const CALL_TIMEOUT_MS = 90_000;

export const NOT_CONFIGURED = "No AI provider configured — add an API key in Settings.";
export const NO_MODEL = "No model selected — choose one in Settings.";

export interface ProviderConfig {
  kind: AIProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function stripTrailingSlash(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/** Resolve wire config for a provider; defaults to the active provider. */
export function resolveConfig(kind?: AIProviderKind): ProviderConfig {
  const ai = settingsRepo.getApp().ai;
  const target = kind ?? ai.provider;
  const isActive = target === ai.provider;
  if (target === "anthropic") {
    return {
      kind: "anthropic",
      baseUrl: ANTHROPIC_BASE,
      apiKey: ai.anthropicKey.trim(),
      model: isActive ? ai.model.trim() : "",
    };
  }
  if (target === "custom") {
    return {
      kind: "custom",
      baseUrl: stripTrailingSlash(ai.customBaseUrl),
      apiKey: ai.customKey.trim(),
      model: ai.customModel.trim() || (isActive ? ai.model.trim() : ""),
    };
  }
  return {
    kind: "openai",
    baseUrl: OPENAI_BASE,
    apiKey: ai.openaiKey.trim(),
    model: isActive ? ai.model.trim() : "",
  };
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
}

export interface StreamOutcome {
  text: string;
  toolCalls: LlmToolCall[];
}

export interface CompleteArgs {
  cfg: ProviderConfig;
  system: string;
  prompt: string;
  maxTokens: number;
  signal: AbortSignal;
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
