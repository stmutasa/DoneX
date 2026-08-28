import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { projectsRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  name: z.string(),
  color: z.string().optional(),
  icon: z.string().optional(),
});

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  return NextResponse.json({ projects: projectsRepo.list() });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !parsed.data.name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  return NextResponse.json({ project: projectsRepo.create(parsed.data) });
}
