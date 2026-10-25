import type { ModelInfo } from "@/lib/types";
import { readUsage, recordAiUsage } from "@/lib/ai/usage";
import { asArray, asNumber, asRecord, asString, safeJsonParse } from "@/lib/ai/json";
import { iterateSse } from "@/lib/ai/sse";
import { toOpenAiTools } from "@/lib/ai/tools";
import {
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

export function toOpenAiMessages(system: string, turns: LlmTurn[]): unknown[] {
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
        msg.tool_calls = turn.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.args || "{}" },
        }));
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
      messages: toOpenAiMessages(system, turns),
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

  for await (const msg of iterateSse(res.body)) {
    if (msg.data === "[DONE]") break;
    const payload = asRecord(safeJsonParse(msg.data));
    if (!payload) continue;
    if (payload.usage) {
      recordAiUsage({ provider: cfg.kind, model: cfg.model, feature, ...readUsage(payload.usage) });
    }
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
      calls.set(index, acc);
    }
  }

  const toolCalls: LlmToolCall[] = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, c]) => c.name.length > 0)
    .map(([index, c]) => ({ id: c.id || `call_${index}`, name: c.name, args: c.args }));

  return { text, toolCalls };
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

  const send = async (tokenField: "max_tokens" | "max_completion_tokens") =>
    fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: headers(cfg),
      body: JSON.stringify({ model: cfg.model, messages, [tokenField]: maxTokens }),
      signal,
    });

  let res = await send("max_tokens");
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    // Newer OpenAI reasoning models reject max_tokens and demand the new field.
    if (raw.includes("max_completion_tokens")) {
      res = await send("max_completion_tokens");
      if (!res.ok) throw await providerError(res);
    } else {
      throw new Error(cleanProviderMessage(res.status, raw));
    }
  }

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
  return parts;
}

const EXCLUDE_MODEL =
  /(embed|whisper|tts|dall-e|audio|realtime|moderation|image|transcribe|search|instruct-beta|davinci|babbage|computer-use|codex-mini)/i;

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
    .filter((m) => /^gemini/i.test(m.id) && !/embedding|tts|image|imagen|live|audio|aqa/i.test(m.id));
  const listed = selectOpenAiModels(chat, false).map((m) =>
    m.id === GEMINI_ARGON_ID ? { id: m.id, label: "Gemini 4 Argon" } : m,
  );
  if (listed.some((m) => m.id === GEMINI_ARGON_ID)) return listed;
  return [...listed, { id: GEMINI_ARGON_ID, label: "Gemini 4 Argon — not offered to this key yet" }];
}

export const openaiAdapter: ProviderAdapter = { stream, complete, models };
