import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { feedbackRepo, inboxRepo, notesRepo, tasksRepo } from "@/lib/db/repos";
import type { TaskDraft } from "@/lib/types";
import { newId } from "@/lib/utils";

export const dynamic = "force-dynamic";

const taskDraftSchema = z.object({
  title: z.string(),
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
});

const bodySchema = z.object({
  action: z.enum(["task", "note", "dismiss"]),
  task: taskDraftSchema.optional(),
  note: z.object({ title: z.string().optional(), content: z.string().optional() }).optional(),
  /** dismiss only: the user's "dismiss because…" — becomes a triage lesson */
  reason: z.string().max(240).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSession();
  if (gate) return gate;
  const { id } = await params;

  const item = inboxRepo.get(id);
  if (!item) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const body = parsed.data;

  if (body.action === "task") {
    const draft: TaskDraft = body.task ?? item.suggestion?.task ?? { title: item.content.slice(0, 120) };
    if (!draft.title.trim()) {
      return NextResponse.json({ error: "Title is required" }, { status: 400 });
    }
    const task = tasksRepo.create(draft);
    inboxRepo.resolve(id, "resolved", task.id);
    return NextResponse.json({ ok: true, taskId: task.id });
  }

  if (body.action === "note") {
    const title = body.note?.title ?? item.suggestion?.note?.title ?? "Inbox";
    const content = body.note?.content ?? item.suggestion?.note?.content ?? item.content;
    const existing = notesRepo.findByTitle(title);
    if (existing) {
      if (existing.kind === "checklist") {
        notesRepo.update(existing.id, {
          items: [...existing.items, { id: newId(), text: content, done: false }],
        });
      } else {
        notesRepo.update(existing.id, {
          content: existing.content ? `${existing.content}\n\n${content}` : content,
        });
      }
    } else {
      notesRepo.create({ title, kind: "note", content });
    }
    inboxRepo.resolve(id, "resolved");
    return NextResponse.json({ ok: true });
  }

  const reason = body.reason?.trim();
  if (reason) {
    feedbackRepo.add({
      kind: "dismiss_because",
      reason,
      content: item.content,
      fromLabel: item.fromLabel,
      source: item.source,
    });
  }
  inboxRepo.resolve(id, "dismissed");
  return NextResponse.json({ ok: true, learned: !!reason });
}
