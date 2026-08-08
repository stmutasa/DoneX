import { conversationsRepo, settingsRepo } from "@/lib/db/repos";
import type {
  ChatMessageRecord,
  ChatStreamEvent,
  Conversation,
  ToolActivity,
} from "@/lib/types";
import { adapterFor, aiConfigured, readyConfig } from "@/lib/ai/adapters";
import { buildAssistantContext } from "@/lib/ai/context";
import { asRecord, safeJsonParse } from "@/lib/ai/json";
import { chatSystemPrompt } from "@/lib/ai/prompts";
import {
  NOT_CONFIGURED,
  describeCallError,
  timeoutSignal,
  type LlmToolResult,
  type LlmTurn,
} from "@/lib/ai/provider";
import { encodeSse } from "@/lib/ai/sse";
import { TOOLS, findTool, toolContext } from "@/lib/ai/tools";

const MAX_TOOL_ROUNDS = 6;
const HISTORY_LIMIT = 24;
const DEFAULT_TITLE = "New chat";

export interface ChatTurnInput {
  conversationId: string | null;
  message: string;
  mode: "chat" | "voice";
}

export function conversationTitleFrom(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  if (!flat) return DEFAULT_TITLE;
  return flat.length > 40 ? `${flat.slice(0, 40).trimEnd()}…` : flat;
}

function pushUserText(turns: LlmTurn[], text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const last = turns[turns.length - 1];
  if (last && last.role === "user") {
    last.text = `${last.text}\n\n${trimmed}`;
    return;
  }
  turns.push({ role: "user", text: trimmed });
}

/** Prior turns, text only, normalised so both providers accept the sequence. */
export function historyTurns(records: ChatMessageRecord[]): LlmTurn[] {
  const turns: LlmTurn[] = [];
  for (const record of records) {
    const text = record.text.trim();
    if (!text) continue;
    if (record.role === "user") {
      pushUserText(turns, text);
      continue;
    }
    if (turns.length === 0) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === "assistant") {
      last.text = `${last.text}\n\n${text}`;
      continue;
    }
    turns.push({ role: "assistant", text, toolCalls: [] });
  }
  return turns;
}

export function runChatTurn(input: ChatTurnInput): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      // The client can navigate away mid-turn; a dead controller must not
      // abort the agent loop or mask the real error.
      const emit = (event: ChatStreamEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(encodeSse(event));
        } catch {
          closed = true;
        }
      };
      const finish = (): void => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed by the consumer
        }
      };

      let conversation: Conversation | null = null;
      const activity: ToolActivity[] = [];

      try {
        const tz = settingsRepo.getApp().tz;
        const message = input.message.trim();

        conversation = input.conversationId
          ? conversationsRepo.get(input.conversationId)
          : null;
        const prior = conversation ? conversationsRepo.messages(conversation.id, HISTORY_LIMIT) : [];

        if (!conversation) {
          conversation = conversationsRepo.create(conversationTitleFrom(message));
        } else if (conversation.title === DEFAULT_TITLE && prior.length === 0) {
          conversationsRepo.rename(conversation.id, conversationTitleFrom(message));
        }

        // Persisted before any provider work so the turn survives a failure.
        conversationsRepo.addMessage(conversation.id, "user", message);

        if (!aiConfigured()) {
          conversationsRepo.addMessage(conversation.id, "assistant", `Sorry — ${NOT_CONFIGURED}`);
          emit({ type: "error", message: NOT_CONFIGURED });
          finish();
          return;
        }

        const turns = historyTurns(prior);
        pushUserText(turns, message);

        const ctx = await buildAssistantContext();
        const system = chatSystemPrompt(ctx, input.mode);
        const cfg = await readyConfig();
        const adapter = adapterFor(cfg.kind);
        const tctx = toolContext(tz);

        let full = "";

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          let pendingBreak = full.length > 0;
          const outcome = await adapter.stream({
            cfg,
            system,
            turns,
            tools: TOOLS,
            signal: timeoutSignal(),
            onText: (chunk) => {
              if (!chunk) return;
              if (pendingBreak) {
                pendingBreak = false;
                full += "\n\n";
                emit({ type: "token", text: "\n\n" });
              }
              full += chunk;
              emit({ type: "token", text: chunk });
            },
          });

          if (outcome.toolCalls.length === 0 || round === MAX_TOOL_ROUNDS) break;

          turns.push({
            role: "assistant",
            text: outcome.text,
            toolCalls: outcome.toolCalls,
          });

          const results: LlmToolResult[] = [];
          for (const call of outcome.toolCalls) {
            const spec = findTool(call.name);
            if (!spec) {
              results.push({
                id: call.id,
                name: call.name,
                content: JSON.stringify({ error: `Unknown tool "${call.name}"` }),
              });
              continue;
            }
            const args = asRecord(safeJsonParse(call.args || "{}")) ?? {};
            let label = spec.name;
            try {
              label = spec.label(args, tctx);
            } catch {
              label = spec.name;
            }
            if (spec.mutating) emit({ type: "tool", label, status: "start" });
            try {
              const out = await spec.run(args, tctx);
              const finalLabel = out.label ?? label;
              const ok = out.ok !== false;
              if (spec.mutating) {
                emit({ type: "tool", label: finalLabel, status: ok ? "ok" : "error" });
                activity.push({ label: finalLabel, ok });
              }
              results.push({
                id: call.id,
                name: call.name,
                content: JSON.stringify(out.payload ?? { ok }),
              });
            } catch (err) {
              const reason = err instanceof Error ? err.message : "Tool failed";
              if (spec.mutating) {
                emit({ type: "tool", label, status: "error" });
                activity.push({ label, ok: false });
              }
              results.push({
                id: call.id,
                name: call.name,
                content: JSON.stringify({ error: reason }),
              });
            }
          }
          turns.push({ role: "toolResults", results });
        }

        if (!full.trim()) {
          const done = activity.filter((a) => a.ok).map((a) => a.label);
          const fallback = done.length > 0 ? `${done.join(". ")}.` : "Done.";
          full = fallback;
          emit({ type: "token", text: fallback });
        }

        const record = conversationsRepo.addMessage(
          conversation.id,
          "assistant",
          full,
          activity
        );
        emit({
          type: "done",
          messageId: record.id,
          conversationId: conversation.id,
          text: full,
          activity,
        });
      } catch (err) {
        const message = describeCallError(err);
        if (conversation) {
          try {
            conversationsRepo.addMessage(
              conversation.id,
              "assistant",
              `Sorry — ${message}`,
              activity
            );
          } catch {
            // persistence is best effort inside the failure path
          }
        }
        emit({ type: "error", message });
      } finally {
        finish();
      }
    },
  });
}
