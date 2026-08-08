import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { tasksRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ ids: z.array(z.string()) });

export async function POST(req: NextRequest) {
  const gate = await requireSession();
  if (gate) return gate;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  tasksRepo.reorder(parsed.data.ids);
  return NextResponse.json({ ok: true });
}
