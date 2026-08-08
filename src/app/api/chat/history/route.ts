import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { conversationsRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const gate = await requireSession();
  if (gate) return gate;

  const id = new URL(req.url).searchParams.get("conversationId");
  const conversation = id
    ? conversationsRepo.get(id)
    : (conversationsRepo.listRecent(1)[0] ?? null);

  if (!conversation) return NextResponse.json({ conversation: null, messages: [] });
  return NextResponse.json({
    conversation,
    messages: conversationsRepo.messages(conversation.id, 200),
  });
}
