import type { ModelInfo } from "@/lib/types";
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
}: StreamArgs): Promise<StreamOutcome> {
  const buildBody = (disableReasoning: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model: cfg.model,
      stream: true,
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
  prompt,
  maxTokens,
  signal,
}: CompleteArgs): Promise<string> {
  const messages = [
    { role: "system", content: system },
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
  return selectOpenAiModels(raw, cfg.kind === "openai");
}

export const openaiAdapter: ProviderAdapter = { stream, complete, models };
