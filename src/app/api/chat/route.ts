import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { runChatTurn } from "@/lib/ai";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  conversationId: z.string().min(1).nullish(),
  message: z.string().trim().min(1).max(8000),
  mode: z.enum(["chat", "voice"]).default("chat"),
  location: z
    .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
    .nullish(),
});

export async function POST(req: Request): Promise<Response> {
  const gate = await requireOwner();
  if (gate) return gate;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 }
    );
  }

  const stream = runChatTurn({
    conversationId: parsed.data.conversationId ?? null,
    message: parsed.data.message,
    mode: parsed.data.mode,
    location: parsed.data.location ?? null,
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
