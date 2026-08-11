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
export type { ChatTurnInput } from "@/lib/ai/chat";

export { runChatTurn } from "@/lib/ai/chat";

export {
  generateBriefing,
  generateDayPlan,
  generateWeeklyReview,
  sweepAutoDismissable,
  triageInboxItem,
} from "@/lib/ai/generate";

export {
  aiConfigured,
  autoPickModelIfNeeded,
  listModels,
  testProvider,
} from "@/lib/ai/adapters";
