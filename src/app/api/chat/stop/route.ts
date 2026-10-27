import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { stopChatTurn } from "@/lib/ai/chat";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ turnId: z.string().min(1).max(100) });

/** The Stop button: end the named turn early. Leaving the page never does. */
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
    return NextResponse.json({ error: "A turn id is required" }, { status: 400 });
  }
  // False when the turn had already finished, which is fine: nothing to stop.
  return NextResponse.json({ stopped: stopChatTurn(parsed.data.turnId) });
}
