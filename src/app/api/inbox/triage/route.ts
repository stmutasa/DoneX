import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { aiConfigured, sweepAutoDismissable, triageInboxItem } from "@/lib/ai";
import { inboxRepo } from "@/lib/db/repos";
import { mapLimit } from "@/lib/utils";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ id: z.string().min(1).optional() });

export async function POST(req: Request): Promise<Response> {
  const gate = await requireSession();
  if (gate) return gate;
  if (!aiConfigured()) return NextResponse.json({ error: "AI not configured" }, { status: 409 });

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = bodySchema.safeParse(raw ?? {});
  const id = parsed.success ? parsed.data.id : undefined;

  if (id) {
    const existing = inboxRepo.get(id);
    if (!existing) return NextResponse.json({ error: "Inbox item not found" }, { status: 404 });
    try {
      return NextResponse.json({ items: [await triageInboxItem(id)] });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not triage the item";
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  const swept = sweepAutoDismissable();

  const pending = inboxRepo
    .list({ status: "new" })
    .filter((item) => item.suggestion === null)
    .slice(0, 30);

  const settled = await mapLimit(pending, 2, (item) => triageInboxItem(item.id));
  const firstFailure = settled.find((r) => r.status === "rejected");

  const items = inboxRepo.list({ status: "new" });
  let kept = 0;
  let dismissed = swept;
  let updated = 0;
  for (const before of pending) {
    const after = inboxRepo.get(before.id);
    if (!after || after.status === "new") kept += 1;
    else if (after.status === "resolved") updated += 1;
    else dismissed += 1;
  }

  if (firstFailure && pending.length > 0 && settled.every((r) => r.status === "rejected")) {
    const reason = firstFailure.reason;
    const message = reason instanceof Error ? reason.message : "Could not triage";
    return NextResponse.json({ error: message }, { status: 502 });
  }
  return NextResponse.json({ items, kept, dismissed, updated });
}
