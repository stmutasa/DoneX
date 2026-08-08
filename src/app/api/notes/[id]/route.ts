import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { notesRepo } from "@/lib/db/repos";
import { NOTE_COLORS } from "@/lib/types";

export const dynamic = "force-dynamic";

const checklistItemSchema = z.object({
  id: z.string(),
  text: z.string(),
  done: z.boolean(),
});

const patchSchema = z.object({
  title: z.string().optional(),
  kind: z.enum(["note", "checklist"]).optional(),
  content: z.string().optional(),
  items: z.array(checklistItemSchema).optional(),
  color: z.enum(NOTE_COLORS).nullable().optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession();
  if (gate) return gate;
  const { id } = await params;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid patch" }, { status: 400 });
  }

  const note = notesRepo.update(id, parsed.data);
  if (!note) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ note });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession();
  if (gate) return gate;
  const { id } = await params;

  notesRepo.remove(id);
  return NextResponse.json({ ok: true });
}
