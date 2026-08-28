import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { projectsRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().optional(),
  color: z.string().optional(),
  icon: z.string().optional(),
  sort: z.number().optional(),
  archived: z.boolean().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOwner();
  if (gate) return gate;
  const { id } = await params;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid patch" }, { status: 400 });
  }
  if (parsed.data.name !== undefined && !parsed.data.name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const project = projectsRepo.update(id, parsed.data);
  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ project });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOwner();
  if (gate) return gate;
  const { id } = await params;

  projectsRepo.remove(id);
  return NextResponse.json({ ok: true });
}
