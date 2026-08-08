import type { ModelInfo } from "@/lib/types";
import { asArray, asNumber, asRecord, asString, safeJsonParse } from "@/lib/ai/json";
import { iterateSse } from "@/lib/ai/sse";
import { toAnthropicTools } from "@/lib/ai/tools";
import {
  ANTHROPIC_VERSION,
  providerError,
  type CompleteArgs,
  type LlmToolCall,
  type LlmTurn,
  type ProviderAdapter,
  type ProviderConfig,
  type StreamArgs,
  type StreamOutcome,
} from "@/lib/ai/provider";

const MAX_TOKENS = 4096;

function headers(cfg: ProviderConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": cfg.apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
  };
}

export function toAnthropicMessages(turns: LlmTurn[]): unknown[] {
  const messages: unknown[] = [];
  for (const turn of turns) {
    if (turn.role === "user") {
      if (!turn.text.trim()) continue;
      messages.push({ role: "user", content: turn.text });
      continue;
    }
    if (turn.role === "assistant") {
      const content: unknown[] = [];
      if (turn.text.trim()) content.push({ type: "text", text: turn.text });
      for (const call of turn.toolCalls) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: asRecord(safeJsonParse(call.args || "{}")) ?? {},
        });
      }
      if (content.length === 0) continue;
      messages.push({ role: "assistant", content });
      continue;
    }
    if (turn.results.length === 0) continue;
    messages.push({
      role: "user",
      content: turn.results.map((r) => ({
        type: "tool_result",
        tool_use_id: r.id,
        content: r.content,
      })),
    });
  }
  return messages;
}

interface BlockAcc {
  type: "text" | "tool_use";
  id: string;
  name: string;
  json: string;
}

async function stream({
  cfg,
  system,
  turns,
  tools,
  onText,
  signal,
}: StreamArgs): Promise<StreamOutcome> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: MAX_TOKENS,
    stream: true,
    system,
    messages: toAnthropicMessages(turns),
  };
  if (tools.length > 0) body.tools = toAnthropicTools(tools);

  const res = await fetch(`${cfg.baseUrl}/messages`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw await providerError(res);

  let text = "";
  const blocks = new Map<number, BlockAcc>();

  for await (const msg of iterateSse(res.body)) {
    const payload = asRecord(safeJsonParse(msg.data));
    if (!payload) continue;
    const type = asString(payload.type) ?? msg.event;

    if (type === "error") {
      const err = asRecord(payload.error);
      const m = asString(err?.message);
      throw new Error(m && m.trim() ? m.trim() : "The AI provider returned an error.");
    }

    if (type === "content_block_start") {
      const index = asNumber(payload.index) ?? blocks.size;
      const block = asRecord(payload.content_block);
      const blockType = asString(block?.type);
      blocks.set(index, {
        type: blockType === "tool_use" ? "tool_use" : "text",
        id: asString(block?.id) ?? "",
        name: asString(block?.name) ?? "",
        json: "",
      });
      continue;
    }

    if (type === "content_block_delta") {
      const index = asNumber(payload.index) ?? 0;
      const delta = asRecord(payload.delta);
      const deltaType = asString(delta?.type);
      if (deltaType === "text_delta") {
        const chunk = asString(delta?.text);
        if (chunk) {
          text += chunk;
          onText(chunk);
        }
      } else if (deltaType === "input_json_delta") {
        const acc = blocks.get(index);
        const chunk = asString(delta?.partial_json);
        if (acc && chunk) acc.json += chunk;
      }
    }
  }

  const toolCalls: LlmToolCall[] = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, b]) => b.type === "tool_use" && b.name.length > 0)
    .map(([index, b]) => ({
      id: b.id || `toolu_${index}`,
      name: b.name,
      args: b.json || "{}",
    }));

  return { text, toolCalls };
}

async function complete({
  cfg,
  system,
  prompt,
  maxTokens,
  signal,
}: CompleteArgs): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/messages`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
    signal,
  });
  if (!res.ok) throw await providerError(res);
  const payload = asRecord(safeJsonParse(await res.text()));
  return asArray(payload?.content)
    .map((entry) => {
      const rec = asRecord(entry);
      return asString(rec?.type) === "text" ? (asString(rec?.text) ?? "") : "";
    })
    .join("");
}

async function models(cfg: ProviderConfig): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let afterId: string | null = null;

  for (let page = 0; page < 5; page++) {
    const url = new URL(`${cfg.baseUrl}/models`);
    url.searchParams.set("limit", "100");
    if (afterId) url.searchParams.set("after_id", afterId);
    const res = await fetch(url.toString(), {
      headers: headers(cfg),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw await providerError(res);
    const payload = asRecord(safeJsonParse(await res.text()));
    for (const entry of asArray(payload?.data)) {
      const rec = asRecord(entry);
      const id = asString(rec?.id);
      if (!id) continue;
      const label = asString(rec?.display_name);
      out.push({ id, label: label && label.trim() ? label : id });
    }
    const hasMore = payload?.has_more === true;
    const lastId = asString(payload?.last_id);
    if (!hasMore || !lastId) break;
    afterId = lastId;
  }

  return out;
}

export const anthropicAdapter: ProviderAdapter = { stream, complete, models };
