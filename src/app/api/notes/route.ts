import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { notesRepo } from "@/lib/db/repos";
import { NOTE_COLORS } from "@/lib/types";

export const dynamic = "force-dynamic";

const checklistItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean(),
});

const noteSchema = z.object({
  title: z.string().optional(),
  kind: z.enum(["note", "checklist"]).optional(),
  content: z.string().optional(),
  items: z.array(checklistItemSchema).optional(),
  color: z.enum(NOTE_COLORS).nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const q = new URL(req.url).searchParams.get("q");
  return NextResponse.json({ notes: notesRepo.list(q ? { q } : {}) });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const parsed = noteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid note" }, { status: 400 });
  }

  return NextResponse.json({ note: notesRepo.create(parsed.data) });
}
