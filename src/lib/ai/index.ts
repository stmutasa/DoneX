/**
 * DoneX AI facade — the ONLY module the rest of the server imports for AI.
 *
 * CONTRACT (implemented in this directory; signatures are frozen — the
 * scheduler, API routes and UI depend on them exactly as declared):
 *
 *  - runChatTurn(input): ReadableStream of SSE bytes following ChatStreamEvent
 *  - generateBriefing / generateDayPlan / generateWeeklyReview: cached per
 *    key unless force; persist via briefings/plans/reviews repos
 *  - triageInboxItem: fills item.suggestion via the utility model
 *  - listModels / testProvider: live model registry per provider
 *  - aiConfigured(): true when the active provider has a key
 *  - autoPickModelIfNeeded(): choose newest sensible model when unset
 */
import type {
  AIProviderKind,
  Briefing,
  DayPlan,
  InboxItem,
  ModelInfo,
  WeeklyReview,
} from "@/lib/types";

export interface ChatTurnInput {
  conversationId: string | null;
  message: string;
  mode: "chat" | "voice";
}

const NOT_IMPLEMENTED = "AI engine not implemented yet";

export function runChatTurn(_input: ChatTurnInput): ReadableStream<Uint8Array> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function generateBriefing(
  _dateLocal: string,
  _opts: { force?: boolean } = {}
): Promise<Briefing> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function generateDayPlan(
  _dateLocal: string,
  _opts: { force?: boolean } = {}
): Promise<DayPlan> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function generateWeeklyReview(
  _weekKey: string,
  _opts: { force?: boolean } = {}
): Promise<WeeklyReview> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function triageInboxItem(_id: string): Promise<InboxItem> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function listModels(_provider: AIProviderKind): Promise<ModelInfo[]> {
  throw new Error(NOT_IMPLEMENTED);
}

export async function testProvider(
  _provider: AIProviderKind
): Promise<{ ok: boolean; message: string }> {
  throw new Error(NOT_IMPLEMENTED);
}

export function aiConfigured(): boolean {
  return false;
}

export async function autoPickModelIfNeeded(): Promise<void> {
  // no-op in stub
}
