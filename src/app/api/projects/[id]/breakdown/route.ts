/**
 * Paragraph → proposed tasks for one project. Returns drafts only — the
 * client shows them for review and files the kept ones through POST
 * /api/tasks, so creation runs through the normal validation path.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { aiConfigured, generateTaskBreakdown } from "@/lib/ai";
import { projectsRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ text: z.string().min(1).max(4000) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOwner();
  if (gate) return gate;
  if (!aiConfigured()) return NextResponse.json({ error: "AI not configured" }, { status: 409 });

  const { id } = await params;
  if (!projectsRepo.get(id)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Paste some text first" }, { status: 400 });
  }

  try {
    const drafts = await generateTaskBreakdown(parsed.data.text.trim(), id);
    return NextResponse.json({ drafts });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not break the text down";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
