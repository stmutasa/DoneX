import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { tasksRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  title: z.string().optional(),
  notes: z.string().optional(),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  dueAt: z.string().nullable().optional(),
  dueKind: z.enum(["on", "by"]).optional(),
  allDay: z.boolean().optional(),
  projectId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  parentId: z.string().nullable().optional(),
  recurrence: z
    .object({
      freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
      interval: z.number().int().positive().optional(),
      byWeekday: z.array(z.number().int().min(0).max(6)).optional(),
      byMonthDay: z.number().int().min(1).max(31).optional(),
    })
    .nullable()
    .optional(),
  location: z
    .object({
      name: z.string().min(1).max(200),
      address: z.string().max(400),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    })
    .nullable()
    .optional(),
  sort: z.number().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession();
  if (gate) return gate;
  const { id } = await params;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid patch" }, { status: 400 });
  }
  if (parsed.data.title !== undefined && !parsed.data.title.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  const task = tasksRepo.update(id, parsed.data);
  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ task });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession();
  if (gate) return gate;
  const { id } = await params;

  tasksRepo.remove(id);
  return NextResponse.json({ ok: true });
}
