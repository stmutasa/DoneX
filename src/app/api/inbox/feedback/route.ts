import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { feedbackRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireSession();
  if (gate) return gate;
  return NextResponse.json({ lessons: feedbackRepo.list(50) });
}

const deleteSchema = z.object({ id: z.string().min(1) });

export async function DELETE(req: NextRequest) {
  const gate = await requireSession();
  if (gate) return gate;
  const parsed = deleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  feedbackRepo.remove(parsed.data.id);
  return NextResponse.json({ ok: true });
}
