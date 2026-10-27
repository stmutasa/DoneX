import { conversationsRepo, settingsRepo, tasksRepo } from "@/lib/db/repos";
import { distanceLabel, haversineKm, nowIso } from "@/lib/utils";
import type {
  ChatMessageRecord,
  ChatStreamEvent,
  Conversation,
  ToolActivity,
} from "@/lib/types";
import {
  adapterFor,
  aiConfigured,
  fallbackConfig,
  isFailoverWorthy,
  workingConfig,
  recordFallback,
} from "@/lib/ai/adapters";
import { buildAssistantContext } from "@/lib/ai/context";
import { asRecord, safeJsonParse } from "@/lib/ai/json";
import { chatSystemPrompt } from "@/lib/ai/prompts";
import {
  NOT_CONFIGURED,
  describeCallError,
  timeoutSignal,
  type LlmToolResult,
  type LlmTurn,
  type ProviderConfig,
} from "@/lib/ai/provider";
import { encodeSse } from "@/lib/ai/sse";
import { TOOLS, findTool, toolContext } from "@/lib/ai/tools";

const MAX_TOOL_ROUNDS = 6;
const HISTORY_LIMIT = 24;
const DEFAULT_TITLE = "New chat";
/** Said when a turn ends with no text and no tool work: a refusal, a content
 *  filter or a reply cut off before it started all come back empty. */
export const EMPTY_REPLY = "No reply came back. Try again, or put it another way.";
/** Saved for a turn stopped before it said anything. */
export const STOPPED_NOTE = "Stopped.";

// Turns in progress, so an explicit Stop (POST /api/chat/stop) can reach the
// one it names. On globalThis so every route bundle shares one map.
const turnGlobal = globalThis as unknown as { __donexChatTurns?: Map<string, AbortController> };
const liveTurns = (turnGlobal.__donexChatTurns ??= new Map<string, AbortController>());

/** Stop the named turn: a tool already writing finishes, no new round starts,
 *  and the reply is saved as far as it got. False when it already ended. */
export function stopChatTurn(turnId: string): boolean {
  const turn = liveTurns.get(turnId);
  if (!turn) return false;
  turn.abort();
  return true;
}

/** A backup that failed as well: why it was covering, then what went wrong. */
function backupFailed(why: string, backup: ProviderConfig, err: unknown): Error {
  return new Error(
    `${why} — and the ${backup.kind} backup (${backup.model}) also failed: ${describeCallError(err)}`,
  );
}

export interface ChatTurnInput {
  conversationId: string | null;
  message: string;
  mode: "chat" | "voice";
  /** client position for this turn — enables nearby-errand awareness */
  location?: { lat: number; lng: number } | null;
}

/** "You are 0.3 mi from CVS (Pick up prescription)" lines for the system
 *  prompt, so walk-mode replies can volunteer what's close without a tool
 *  round-trip. Empty when nothing is within ~2.5km. */
function nearbyDigest(location: { lat: number; lng: number } | null | undefined): string {
  if (!location) return "";
  const located = tasksRepo.located();
  if (located.length === 0) return "";
  const lines = located
    .map((t) => ({ t, km: haversineKm(location, t.location!) }))
    .filter(({ km }) => km <= 2.5)
    .sort((a, b) => a.km - b.km)
    .slice(0, 6)
    .map(({ t, km }) => `- ${distanceLabel(km)} away: ${t.location!.name} — task “${t.title}” (id ${t.id})`);
  if (lines.length === 0) return "";
  return `\n\nNEARBY ERRANDS RIGHT NOW (mention naturally when relevant — e.g. something on their route):\n${lines.join("\n")}`;
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

const NOTE_LABELS = 8;

/**
 * A short line naming the tool work an assistant turn did, so a later turn
 * ("carry on", "try again") knows what already happened even when the saved
 * text doesn't say: a stopped turn, or one whose only words came first.
 * Labels the text already carries are left out, to keep it cheap.
 */
export function activityNote(text: string, activity: ToolActivity[] | undefined): string {
  if (!activity?.length) return "";
  const pick = (ok: boolean) =>
    activity
      .filter((a) => a.ok === ok && !text.includes(a.label))
      .slice(0, NOTE_LABELS)
      .map((a) => a.label.slice(0, 80));
  const done = pick(true);
  const failed = pick(false);
  const parts: string[] = [];
  if (done.length > 0) parts.push(`Done: ${done.join("; ")}`);
  if (failed.length > 0) parts.push(`Didn't work: ${failed.join("; ")}`);
  return parts.length > 0 ? `(${parts.join(". ")})` : "";
}

/** Prior turns, text only, normalised so both providers accept the sequence. */
export function historyTurns(records: ChatMessageRecord[]): LlmTurn[] {
  const turns: LlmTurn[] = [];
  for (const record of records) {
    const said = record.text.trim();
    if (record.role === "user") {
      pushUserText(turns, said);
      continue;
    }
    const text = [said, activityNote(said, record.activity)].filter(Boolean).join("\n");
    if (!text) continue;
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
  let closed = false;
  // Only an explicit Stop ends a turn early. The client going away (another
  // chat, another page, a phone in a pocket) must not cut a plan in half:
  // the turn runs on and is saved for whenever they come back.
  const turnId = crypto.randomUUID();
  const turnAbort = new AbortController();
  liveTurns.set(turnId, turnAbort);
  return new ReadableStream<Uint8Array>({
    cancel() {
      closed = true;
    },
    async start(controller) {
      const emit = (event: ChatStreamEvent): void => {
        if (closed) return;
        try {
          controller.enqueue(encodeSse(event));
        } catch {
          // Nobody is reading any more; carry on regardless.
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
        // Before anything can fail: how to stop this turn, and where it lives,
        // so a retry joins this conversation instead of starting another.
        emit({ type: "meta", turnId, conversationId: conversation.id });

        if (!aiConfigured()) {
          conversationsRepo.addMessage(conversation.id, "assistant", `Sorry — ${NOT_CONFIGURED}`);
          emit({ type: "error", message: NOT_CONFIGURED, conversationId: conversation.id });
          finish();
          return;
        }

        const turns = historyTurns(prior);
        pushUserText(turns, message);

        // Remember the freshest fix so briefings/tools can use it later too.
        if (input.location) {
          settingsRepo.updateApp({ lastLocation: { ...input.location, at: nowIso() } });
        }

        const ctx = await buildAssistantContext();
        const system = chatSystemPrompt(ctx, input.mode) + nearbyDigest(input.location);
        // The backup takes the conversation when the active provider can't run.
        const activeKind = settingsRepo.getApp().ai.provider;
        const start = await workingConfig();
        let cfg = start.cfg;
        let adapter = adapterFor(cfg.kind);
        // Recorded once a reply comes back, so a backup that fails as well is
        // never reported as covering.
        let standIn = start.standIn;
        // Why the turn is on the backup, if it is. One handover per turn: once
        // there, "failing over" again would only repeat the failed request.
        let handover: string | null = start.standIn;
        const tctx = toolContext(tz, input.location);

        let full = "";
        // Tool calls the model still wanted when the rounds ran out.
        let unfinished: string[] | null = null;
        let stopped = false;

        for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
          if (turnAbort.signal.aborted) {
            stopped = true;
            break;
          }
          let pendingBreak = full.length > 0;
          const streamOnce = () =>
            adapter.stream({
              cfg,
              system,
              turns,
              tools: TOOLS,
              feature: "chat",
              signal: AbortSignal.any([timeoutSignal(), turnAbort.signal]),
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

          let outcome: Awaited<ReturnType<typeof streamOnce>>;
          try {
            outcome = await streamOnce();
          } catch (err) {
            if (turnAbort.signal.aborted) {
              stopped = true;
              break;
            }
            if (handover !== null) throw backupFailed(handover, cfg, err);
            // Only safe to retry elsewhere while nothing has been spoken yet —
            // restarting mid-answer would repeat text the user already saw.
            const reason = describeCallError(err);
            const backup = full.length === 0 ? await fallbackConfig() : null;
            const same = backup !== null && backup.kind === cfg.kind && backup.model === cfg.model;
            if (!backup || same || !isFailoverWorthy(reason)) throw err;
            handover = reason;
            const from = cfg.kind;
            cfg = backup;
            adapter = adapterFor(backup.kind);
            try {
              outcome = await streamOnce();
            } catch (backupErr) {
              if (turnAbort.signal.aborted) {
                stopped = true;
                break;
              }
              throw backupFailed(reason, backup, backupErr);
            }
            recordFallback(from, backup, reason);
          }
          if (standIn) {
            recordFallback(activeKind, cfg, standIn);
            standIn = null;
          }

          if (outcome.toolCalls.length === 0) break;
          if (round === MAX_TOOL_ROUNDS) {
            // Out of rounds. Say what was left undone rather than drop it.
            unfinished = outcome.toolCalls.flatMap((call) => {
              const spec = findTool(call.name);
              if (!spec?.mutating) return [];
              try {
                return [spec.label(asRecord(safeJsonParse(call.args || "{}")) ?? {}, tctx)];
              } catch {
                return [spec.name];
              }
            });
            break;
          }

          turns.push({
            role: "assistant",
            text: outcome.text,
            toolCalls: outcome.toolCalls,
          });

          const results: LlmToolResult[] = [];
          for (const call of outcome.toolCalls) {
            // A stop lands between tools, never in the middle of one's write.
            if (turnAbort.signal.aborted) break;
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

        if (stopped) {
          // Saved as far as it got, so the transcript still reads in order.
          const record = conversationsRepo.addMessage(
            conversation.id,
            "assistant",
            full.trim() ? full : STOPPED_NOTE,
            activity,
          );
          emit({ type: "done", messageId: record.id, conversationId: conversation.id, text: record.text, activity });
          return;
        }

        const say = (text: string): void => {
          const piece = full.trim() ? `\n\n${text}` : text;
          full += piece;
          emit({ type: "token", text: piece });
        };
        if (!full.trim()) {
          // The model went quiet after its tools: report what they did, and
          // only what they did.
          const done = activity.filter((a) => a.ok).map((a) => a.label);
          const failed = activity.filter((a) => !a.ok).map((a) => a.label);
          if (done.length > 0) say(`${done.join(". ")}.`);
          if (failed.length > 0) say(`That didn't work: ${failed.join(". ")}.`);
        }
        if (unfinished) {
          say(
            unfinished.length > 0
              ? `I hit my step limit, so ${unfinished.length === 1 ? "this step" : "these steps"} didn't run: ${unfinished.join("; ")}. Ask me to carry on.`
              : "I hit my step limit before I could finish. Ask me to carry on.",
          );
        }
        // No text and no tool work at all is not a success.
        if (!full.trim()) throw new Error(EMPTY_REPLY);

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
        emit(
          conversation
            ? { type: "error", message, conversationId: conversation.id }
            : { type: "error", message },
        );
      } finally {
        liveTurns.delete(turnId);
        finish();
      }
    },
  });
}
