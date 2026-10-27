import type { AIProviderKind, ModelInfo } from "@/lib/types";
import { readUsage, recordAiUsage } from "@/lib/ai/usage";
import { asArray, asNumber, asRecord, asString, safeJsonParse } from "@/lib/ai/json";
import { iterateSse } from "@/lib/ai/sse";
import { toOpenAiTools } from "@/lib/ai/tools";
import {
  OUT_OF_TOKENS,
  REASONING_HEADROOM,
  cleanProviderMessage,
  providerError,
  type CompleteArgs,
  type LlmToolCall,
  type LlmTurn,
  type ProviderAdapter,
  type ProviderConfig,
  type StreamArgs,
  type StreamOutcome,
} from "@/lib/ai/provider";

interface ToolCallAcc {
  id: string;
  name: string;
  args: string;
  extra?: Record<string, unknown>;
}

function headers(cfg: ProviderConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
  };
}

/** The system message with the shared, cacheable text appended in order. */
export function openAiSystem(system: string, shared: string[] = []): string {
  const segments = shared.map((x) => x.trim()).filter(Boolean);
  return segments.length ? [system, ...segments].join("\n\n") : system;
}

/**
 * What Gemini documents for a function call it did not make itself (a step
 * another provider took before a failover), which has no signature to send.
 */
export const GEMINI_SKIP_SIGNATURE = { google: { thought_signature: "skip_thought_signature_validator" } };

/**
 * `target` is the provider the messages go to. Gemini signs the first call of
 * each step it takes and rejects the next request in that turn unless the
 * signature comes back with it, so whatever a provider attached to a call is
 * echoed — but only to the provider that attached it. Strict servers (OpenAI,
 * Mistral) reject fields they don't know, which a failover mid-turn would
 * otherwise hand them.
 */
export function toOpenAiMessages(system: string, turns: LlmTurn[], target?: AIProviderKind): unknown[] {
  const own = (c: LlmToolCall) => (target && c.origin === target ? c.extraContent : undefined);
  const messages: unknown[] = [{ role: "system", content: system }];
  for (const turn of turns) {
    if (turn.role === "user") {
      messages.push({ role: "user", content: turn.text });
    } else if (turn.role === "assistant") {
      const msg: Record<string, unknown> = {
        role: "assistant",
        content: turn.text ? turn.text : null,
      };
      if (turn.toolCalls.length > 0) {
        const unsigned = target === "gemini" && !turn.toolCalls.some((c) => own(c));
        msg.tool_calls = turn.toolCalls.map((c, i) => {
          const call: Record<string, unknown> = {
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.args || "{}" },
          };
          const extra = own(c) ?? (unsigned && i === 0 ? GEMINI_SKIP_SIGNATURE : undefined);
          if (extra) call.extra_content = extra;
          return call;
        });
      }
      messages.push(msg);
    } else {
      for (const r of turn.results) {
        messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
      }
    }
  }
  return messages;
}

/**
 * Providers send a tool-call name either once (OpenAI) or repeated whole on
 * every delta; only genuinely new fragments are appended.
 */
export function mergeToolName(current: string, fragment: string): string {
  if (!fragment) return current;
  if (!current) return fragment;
  if (current === fragment || current.endsWith(fragment)) return current;
  return current + fragment;
}

/**
 * Newer reasoning models (gpt-5.x and friends) reject function tools on
 * /v1/chat/completions unless reasoning is explicitly switched off. The
 * requirement is per-model and not advertised anywhere we can query, so the
 * first rejection is turned into a retry and remembered — one wasted request
 * per model per process, rather than one per turn.
 */
const NEEDS_REASONING_NONE = new Set<string>();

export function mentionsReasoningEffort(raw: string): boolean {
  return /reasoning_effort/i.test(raw);
}

async function stream({
  cfg,
  system,
  turns,
  tools,
  onText,
  signal,
  feature,
}: StreamArgs): Promise<StreamOutcome> {
  const buildBody = (disableReasoning: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model: cfg.model,
      stream: true,
      // Ask for a final usage chunk; servers that don't know the option
      // simply never send one, and the call still works.
      stream_options: { include_usage: true },
      messages: toOpenAiMessages(system, turns, cfg.kind),
    };
    if (tools.length > 0) {
      body.tools = toOpenAiTools(tools);
      body.tool_choice = "auto";
      if (disableReasoning) body.reasoning_effort = "none";
    }
    return body;
  };

  const send = (disableReasoning: boolean) =>
    fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify(buildBody(disableReasoning)),
      signal,
    });

  const alreadyDisabled = NEEDS_REASONING_NONE.has(cfg.model);
  let res = await send(alreadyDisabled);

  if (!res.ok && !alreadyDisabled) {
    const raw = await res.text().catch(() => "");
    if (tools.length > 0 && mentionsReasoningEffort(raw)) {
      NEEDS_REASONING_NONE.add(cfg.model);
      res = await send(true);
    } else {
      throw new Error(cleanProviderMessage(res.status, raw));
    }
  }
  if (!res.ok || !res.body) throw await providerError(res);

  let text = "";
  const calls = new Map<number, ToolCallAcc>();
  // OpenAI reports usage once, on the last chunk; other servers repeat the
  // running total on many chunks. Either way the last one seen is the call's.
  let usage: unknown = null;

  try {
    for await (const msg of iterateSse(res.body)) {
      if (msg.data === "[DONE]") break;
      const payload = asRecord(safeJsonParse(msg.data));
      if (!payload) continue;
      if (payload.usage) usage = payload.usage;
      const errMsg = asRecord(payload.error);
      if (errMsg) {
        const m = asString(errMsg.message);
        throw new Error(m && m.trim() ? m.trim() : "The AI provider returned an error.");
      }
      const choice = asRecord(asArray(payload.choices)[0]);
      if (!choice) continue;
      const delta = asRecord(choice.delta);
      if (!delta) continue;

      const content = asString(delta.content);
      if (content) {
        text += content;
        onText(content);
      }

      for (const entry of asArray(delta.tool_calls)) {
        const tc = asRecord(entry);
        if (!tc) continue;
        const index = asNumber(tc.index) ?? calls.size;
        const acc = calls.get(index) ?? { id: "", name: "", args: "" };
        const id = asString(tc.id);
        if (id) acc.id = id;
        const fn = asRecord(tc.function);
        if (fn) {
          const name = asString(fn.name);
          if (name) acc.name = mergeToolName(acc.name, name);
          const args = asString(fn.arguments);
          if (args) acc.args += args;
        }
        const extra = asRecord(tc.extra_content);
        if (extra) acc.extra = extra;
        calls.set(index, acc);
      }
    }
  } finally {
    if (usage) recordAiUsage({ provider: cfg.kind, model: cfg.model, feature, ...readUsage(usage) });
  }

  const toolCalls: LlmToolCall[] = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, c]) => c.name.length > 0)
    .map(([index, c]) => ({
      id: c.id || `call_${index}`,
      name: c.name,
      args: c.args,
      origin: cfg.kind,
      ...(c.extra ? { extraContent: c.extra } : {}),
    }));

  return { text, toolCalls };
}

/**
 * Families whose default reasoning effort is above "low": OpenAI's o-series
 * and its first GPT-5 releases (medium), and Gemini's Pro and Flash tiers from
 * 2.5 on (medium or higher). Asking those for low can only cut what a call
 * spends. Everything else keeps its own default: OpenAI's later GPT-5 point
 * releases default to none, Flash-Lite thinks little or not at all, and an
 * unknown or custom id could be either, so asking it for low might raise the
 * bill.
 */
const OPENAI_EFFORT_ABOVE_LOW = /^(?:o[134](?:-mini)?|gpt-5(?:-mini|-nano)?)(?:-\d{4}-\d{2}-\d{2})?$/;
const GEMINI_EFFORT_ABOVE_LOW =
  /^(?:gemini-2\.5-(?:pro|flash)|gemini-3(?:\.\d+)?-(?:pro|flash)|gemini-4(?=[.-]|$))(?![\w.-]*(?:-lite|image|tts|live|audio|embed|robotics|computer-use))/;

export function lowEffortCutsSpend(kind: AIProviderKind, model: string): boolean {
  const id = model.trim().toLowerCase();
  if (kind === "openai") return OPENAI_EFFORT_ABOVE_LOW.test(id);
  if (kind === "gemini") return GEMINI_EFFORT_ABOVE_LOW.test(id);
  return false;
}

async function complete({
  cfg,
  system,
  shared,
  prompt,
  maxTokens,
  signal,
  feature,
}: CompleteArgs): Promise<string> {
  // OpenAI caches any prefix it has seen recently (from about 1,024 tokens),
  // with no flag to set. All that earns the discount is ordering: the shared
  // text goes first and byte-identical, the per-call part last.
  const messages = [
    { role: "system", content: openAiSystem(system, shared) },
    { role: "user", content: prompt },
  ];

  // A thinking model counts its hidden reasoning against the same cap as the
  // answer, so a cap sized for the answer alone can run out before a word of
  // it is written. Gemini can think on every current model; on OpenAI, the
  // models that demand max_completion_tokens are the reasoning ones. They all
  // get the headroom, which bills nothing unused; only families whose default
  // effort is higher are asked for low.
  let tokenField: "max_tokens" | "max_completion_tokens" = "max_tokens";
  let thinks = cfg.kind === "gemini";
  let lowEffort = thinks && lowEffortCutsSpend(cfg.kind, cfg.model);

  const send = async () =>
    fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify({
        model: cfg.model,
        messages,
        [tokenField]: thinks ? maxTokens + REASONING_HEADROOM : maxTokens,
        ...(lowEffort ? { reasoning_effort: "low" } : {}),
      }),
      signal,
    });

  let res = await send();
  for (let retry = 0; !res.ok && retry < 2; retry++) {
    const raw = await res.text().catch(() => "");
    if (tokenField === "max_tokens" && raw.includes("max_completion_tokens")) {
      // Newer OpenAI reasoning models reject max_tokens and demand the new field.
      tokenField = "max_completion_tokens";
      thinks = true;
      lowEffort = lowEffortCutsSpend(cfg.kind, cfg.model);
    } else if (lowEffort && /reasoning|thinking/i.test(raw)) {
      // A model that can't be told how hard to think still gets the room.
      lowEffort = false;
    } else {
      throw new Error(cleanProviderMessage(res.status, raw));
    }
    res = await send();
  }
  if (!res.ok) throw await providerError(res);

  const payload = asRecord(safeJsonParse(await res.text()));
  recordAiUsage({ provider: cfg.kind, model: cfg.model, feature, ...readUsage(payload?.usage) });
  const choice = asRecord(asArray(payload?.choices)[0]);
  const message = asRecord(choice?.message);
  const content = asString(message?.content);
  if (content) return content;
  // Some OpenAI-compatible servers put the text in an array of parts.
  const parts = asArray(message?.content)
    .map((p) => asString(asRecord(p)?.text) ?? "")
    .join("");
  if (!parts && asString(choice?.finish_reason) === "length") throw new Error(OUT_OF_TOKENS);
  return parts;
}

// The codex and -pro families are served on the Responses API only, so
// /chat/completions rejects them outright.
const EXCLUDE_MODEL =
  /(embed|whisper|tts|dall-e|audio|realtime|moderation|image|transcribe|search|instruct-beta|davinci|babbage|computer-use|codex|-pro(?:-|$))/i;

export function isChatCapableModelId(id: string): boolean {
  const lower = id.toLowerCase();
  if (EXCLUDE_MODEL.test(lower)) return false;
  return lower.startsWith("gpt") || lower.includes("chat") || /^o\d/.test(lower);
}

interface RawModel {
  id: string;
  created: number | null;
}

export function selectOpenAiModels(raw: RawModel[], filterChat: boolean): ModelInfo[] {
  const kept = filterChat ? raw.filter((m) => isChatCapableModelId(m.id)) : raw;
  const sorted = [...kept].sort((a, b) => {
    if (a.created !== null && b.created !== null && a.created !== b.created) {
      return b.created - a.created;
    }
    if (a.created !== null && b.created === null) return -1;
    if (a.created === null && b.created !== null) return 1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return sorted.map((m) => ({ id: m.id, label: m.id }));
}

async function models(cfg: ProviderConfig): Promise<ModelInfo[]> {
  const res = await fetch(`${cfg.baseUrl}/models`, {
    headers: headers(cfg),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw await providerError(res);
  const payload = asRecord(safeJsonParse(await res.text()));
  const raw: RawModel[] = asArray(payload?.data)
    .map((entry) => {
      const rec = asRecord(entry);
      const id = asString(rec?.id);
      return id ? { id, created: asNumber(rec?.created) } : null;
    })
    .filter((m): m is RawModel => m !== null);
  if (cfg.kind === "gemini") return selectGeminiModels(raw);
  return selectOpenAiModels(raw, cfg.kind === "openai");
}

/** Gemini 4 Argon has its own slot in the list, whether or not Google lists it. */
export const GEMINI_ARGON_ID = "gemini-4-argon";

/** The version right after "gemini-" as numbers ("3.8" → [3, 8]); null for an unversioned alias. */
function geminiVersion(id: string): number[] | null {
  const m = /^gemini-(\d+(?:\.\d+)*)/i.exec(id);
  return m ? m[1].split(".").map(Number) : null;
}

const GEMINI_PREVIEW = /(?:^|-)(?:preview|exp|experimental)(?:-|$)/i;

/**
 * Gemini's list carries no release dates, and string order puts letters after
 * digits (an unversioned alias over every numbered release) and "10" before
 * "9". So:
 * highest version first, a stable release ahead of a preview of the same one,
 * and unversioned aliases last.
 */
export function compareGeminiIds(a: string, b: string): number {
  const va = geminiVersion(a);
  const vb = geminiVersion(b);
  if (va && !vb) return -1;
  if (!va && vb) return 1;
  if (va && vb) {
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const d = (vb[i] ?? 0) - (va[i] ?? 0);
      if (d) return d;
    }
  }
  const pa = GEMINI_PREVIEW.test(a);
  const pb = GEMINI_PREVIEW.test(b);
  if (pa !== pb) return pa ? 1 : -1;
  return a < b ? 1 : a > b ? -1 : 0;
}

/**
 * Gemini's catalogue through its OpenAI-compatible endpoint: chat models
 * only, ids without the "models/" prefix the native API uses, newest first.
 *
 * Gemini 4 Argon always has a place. Access has been gated by Google, so a key
 * may not be offered it yet; then it sits at the end, saying so, rather than
 * first — the head of the list is what "auto" and the backup pick, and that
 * must be a model the key can actually use.
 */
export function selectGeminiModels(raw: RawModel[]): ModelInfo[] {
  const chat = raw
    .map((m) => ({ ...m, id: m.id.replace(/^models\//, "") }))
    .filter(
      (m) =>
        /^gemini/i.test(m.id) &&
        !/embedding|tts|image|imagen|live|audio|aqa|robotics|computer-use/i.test(m.id),
    );
  const listed = [...chat]
    .sort((a, b) => compareGeminiIds(a.id, b.id))
    .map((m) => (m.id === GEMINI_ARGON_ID ? { id: m.id, label: "Gemini 4 Argon" } : { id: m.id, label: m.id }));
  if (listed.some((m) => m.id === GEMINI_ARGON_ID)) return listed;
  return [...listed, { id: GEMINI_ARGON_ID, label: "Gemini 4 Argon — not offered to this key yet" }];
}

export const openaiAdapter: ProviderAdapter = { stream, complete, models };
