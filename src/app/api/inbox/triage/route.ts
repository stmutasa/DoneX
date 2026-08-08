import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { aiConfigured, triageInboxItem } from "@/lib/ai";
import { inboxRepo } from "@/lib/db/repos";

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

  const pending = inboxRepo.list({ status: "new" }).filter((item) => item.suggestion === null);
  let failure = "";
  for (const item of pending.slice(0, 20)) {
    try {
      await triageInboxItem(item.id);
    } catch (err) {
      failure = err instanceof Error ? err.message : "Could not triage the item";
      break;
    }
  }

  const items = inboxRepo.list({ status: "new" });
  if (failure && items.every((item) => item.suggestion === null)) {
    return NextResponse.json({ error: failure }, { status: 502 });
  }
  return NextResponse.json({ items });
}
