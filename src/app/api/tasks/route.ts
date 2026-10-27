import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, sessionRole } from "@/lib/auth";
import { projectsRepo, settingsRepo, tasksRepo } from "@/lib/db/repos";
import { parseQuickAdd } from "@/lib/quickparse";
import { alertAssignee } from "@/lib/assignNotify";
import type { TaskDraft, TaskListFilter } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Brackets the placeholder a "#word" hides behind while a quick-add is parsed. */
const HASH_MASK = "";

const VIEWS = ["today", "upcoming", "anytime", "all"] as const;
type ViewParam = (typeof VIEWS)[number];
function isView(v: string): v is ViewParam {
  return (VIEWS as readonly string[]).includes(v);
}

const recurrenceSchema = z
  .object({
    freq: z.enum(["daily", "weekly", "monthly", "yearly"]),
    interval: z.number().int().positive().optional(),
    byWeekday: z.array(z.number().int().min(0).max(6)).optional(),
    byMonthDay: z.number().int().min(1).max(31).optional(),
  })
  .nullable()
  .optional();

const locationSchema = z
  .object({
    name: z.string().min(1).max(200),
    address: z.string().max(400),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  })
  .nullable()
  .optional();

const draftSchema = z.object({
  title: z.string(),
  notes: z.string().optional(),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  space: z.enum(["personal", "joint"]).optional(),
  assignedTo: z.enum(["owner", "partner"]).nullable().optional(),
  dueAt: z.string().nullable().optional(),
  dueKind: z.enum(["on", "by"]).optional(),
  allDay: z.boolean().optional(),
  projectId: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  parentId: z.string().nullable().optional(),
  recurrence: recurrenceSchema,
  location: locationSchema,
});

export async function GET(req: NextRequest) {
  const gate = await requireSession();
  if (gate) return gate;
  const role = (await sessionRole()) ?? "owner";

  const { searchParams } = new URL(req.url);
  const filter: TaskListFilter = {};
  const view = searchParams.get("view");
  if (view && isView(view)) filter.view = view;
  const projectId = searchParams.get("projectId");
  if (projectId) filter.projectId = projectId;
  const tag = searchParams.get("tag");
  if (tag) filter.tag = tag;
  const q = searchParams.get("q");
  if (q) filter.q = q;
  if (searchParams.get("includeDone") === "1") filter.includeDone = true;
  if (searchParams.get("excludeProjects") === "1") filter.excludeProjects = true;
  if (searchParams.get("space") === "joint") filter.space = "joint";
  // A partner session sees exactly one list, whatever it asked for.
  if (role === "partner") filter.space = "joint";

  return NextResponse.json({ tasks: tasksRepo.list(filter) });
}

export async function POST(req: NextRequest) {
  const gate = await requireSession();
  if (gate) return gate;
  const role = (await sessionRole()) ?? "owner";

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid task" }, { status: 400 });
  }

  let draft: TaskDraft;
  const quick = (body as Record<string, unknown>).quick;
  if (typeof quick === "string") {
    const settings = settingsRepo.getApp();
    // Offline quick-adds carry the moment they were typed, so relative dates
    // parse against that instead of the (possibly next-day) sync time.
    const capturedAtRaw = (body as Record<string, unknown>).capturedAt;
    const capturedAt =
      typeof capturedAtRaw === "string" ? new Date(capturedAtRaw) : undefined;
    // Only the owner's personal list files into projects. Anywhere else a
    // "#word" is just part of what was typed, so it stays in the title and
    // never creates a project.
    const filesProjects = role === "owner" && (body as Record<string, unknown>).space !== "joint";
    // Each "#word" is hidden whole behind a placeholder with no letters or
    // digits, so neither the project parser nor the date parser sees it
    // ("call #tomorrow" stays a title, not a due date).
    const hidden: string[] = [];
    const masked = filesProjects
      ? quick
      : quick.replace(/#[^\s#]*/g, (token) => {
          hidden.push(token);
          return `${HASH_MASK}${String.fromCharCode(0xe100 + hidden.length - 1)}${HASH_MASK}`;
        });
    const { draft: quickDraft, matchedText } = parseQuickAdd(masked, settings.tz, capturedAt);
    draft = quickDraft;
    if (hidden.length) {
      draft.title = draft.title.replace(
        new RegExp(`${HASH_MASK}([\\ue100-\\uf8ff])${HASH_MASK}`, "g"),
        (_m, ch: string) => hidden[ch.charCodeAt(0) - 0xe100] ?? ""
      );
    }
    if ((body as Record<string, unknown>).space === "joint") draft.space = "joint";
    const tagged = (body as Record<string, unknown>).assignedTo;
    if (tagged === "owner" || tagged === "partner") draft.assignedTo = tagged;
    if (filesProjects && matchedText.project) {
      const project =
        projectsRepo.findByName(matchedText.project) ?? projectsRepo.create({ name: matchedText.project });
      draft.projectId = project.id;
    }
  } else {
    const parsed = draftSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid task" }, { status: 400 });
    }
    draft = parsed.data;
  }

  if (!draft.title.trim()) {
    return NextResponse.json({ error: "Title is required" }, { status: 400 });
  }

  // A subtask needs a real parent, and takes that parent's list. An empty id
  // means no parent; stored as-is it would hide the task from every list.
  if (draft.parentId === "") draft.parentId = null;
  if (draft.parentId) {
    const parent = tasksRepo.get(draft.parentId);
    if (!parent) {
      return NextResponse.json({ error: "The parent task no longer exists" }, { status: 400 });
    }
    // A partner sees only the joint list, so any other parent is not there.
    if (role === "partner" && parent.space !== "joint") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    // Lists show one level of subtasks, so anything deeper would vanish.
    if (parent.parentId) {
      return NextResponse.json({ error: "Subtasks can't have subtasks" }, { status: 400 });
    }
    draft.space = parent.space;
  }
  // Partner sessions write only to the joint list, and never into projects.
  if (role === "partner") {
    draft.space = "joint";
    draft.projectId = null;
  }
  // Only the shared list has someone else to hand a task to.
  if (draft.space !== "joint") draft.assignedTo = null;

  const task = tasksRepo.create(draft, role);
  await alertAssignee(task, role, null);
  return NextResponse.json({ task });
}

