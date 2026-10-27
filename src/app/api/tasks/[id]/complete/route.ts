import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, sessionRole } from "@/lib/auth";
import { tasksRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  done: z.boolean(),
  /** The due the client was looking at, so a stale tick can't skip a repeat ahead twice. */
  expectedDueAt: z.string().nullable().optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession();
  if (gate) return gate;
  const { id } = await params;
  const role = (await sessionRole()) ?? "owner";
  if (role === "partner" && tasksRepo.get(id)?.space !== "joint") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const { task, recurred, changed } = tasksRepo.setDone(id, parsed.data.done, {
    by: role,
    expectedDueAt: parsed.data.expectedDueAt,
  });
  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ task, recurred, changed });
}
