import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { feedbackRepo, inboxRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** why the auto-dismissal was wrong — becomes a triage lesson */
  reason: z.string().max(240).optional(),
});

/** Bring a dismissed/resolved item back to the inbox, optionally teaching
 *  triage why it should never have gone. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOwner();
  if (gate) return gate;
  const { id } = await params;

  const item = inboxRepo.get(id);
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (item.status === "new") return NextResponse.json({ ok: true, learned: false });

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  const reason = parsed.success ? parsed.data.reason?.trim() : undefined;

  if (reason) {
    feedbackRepo.add({
      kind: "should_have_kept",
      reason,
      content: item.content,
      fromLabel: item.fromLabel,
      source: item.source,
    });
  }
  inboxRepo.restore(id);
  return NextResponse.json({ ok: true, learned: !!reason });
}
