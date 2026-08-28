import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { inboxRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  content: z.string().min(1),
  source: z.literal("quick").optional(),
});

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const status = new URL(req.url).searchParams.get("status");
  const items = inboxRepo.list({ status: status === "all" ? "all" : "new" });
  return NextResponse.json({ items, newCount: inboxRepo.newCount() });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const item = inboxRepo.create({ source: "quick", content: parsed.data.content });
  return NextResponse.json({ item });
}
