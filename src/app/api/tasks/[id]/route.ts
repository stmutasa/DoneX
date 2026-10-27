import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, sessionRole } from "@/lib/auth";
import { tasksRepo } from "@/lib/db/repos";
import { alertAssignee } from "@/lib/assignNotify";

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
  assignedTo: z.enum(["owner", "partner"]).nullable().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession();
  if (gate) return gate;
  const { id } = await params;
  const role = (await sessionRole()) ?? "owner";
  const before = tasksRepo.get(id);
  if (role === "partner" && before?.space !== "joint") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid patch" }, { status: 400 });
  }
  if (parsed.data.title !== undefined && !parsed.data.title.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }
  const patch = parsed.data;
  // Partner sessions never write into projects, as on create.
  if (role === "partner") delete patch.projectId;
  // An empty id means no parent; stored as-is it would hide the task everywhere.
  if (patch.parentId === "") patch.parentId = null;
  if (patch.parentId) {
    if (patch.parentId === id) {
      return NextResponse.json({ error: "A task can't be its own subtask" }, { status: 400 });
    }
    const parent = tasksRepo.get(patch.parentId);
    if (!parent) {
      return NextResponse.json({ error: "The parent task no longer exists" }, { status: 400 });
    }
    // Nor under anything off the joint list, which a partner can't see.
    if (role === "partner" && parent.space !== "joint") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // Lists show one level of subtasks, so nesting under a subtask, or moving
    // a task that has its own, would make tasks vanish (or loop).
    if (parent.parentId || (before?.subtasks?.length ?? 0) > 0) {
      return NextResponse.json({ error: "Subtasks can't have subtasks" }, { status: 400 });
    }
  }

  const task = tasksRepo.update(id, patch);
  if (!task) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if ("assignedTo" in parsed.data) {
    await alertAssignee(task, role, before?.assignedTo ?? null);
  }
  return NextResponse.json({ task });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession();
  if (gate) return gate;
  const { id } = await params;
  if (((await sessionRole()) ?? "owner") === "partner" && tasksRepo.get(id)?.space !== "joint") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  tasksRepo.remove(id);
  return NextResponse.json({ ok: true });
}
