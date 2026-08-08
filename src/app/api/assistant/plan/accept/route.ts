import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { plansRepo, settingsRepo } from "@/lib/db/repos";
import { createEventOnCalendar } from "@/lib/google/calendar";
import { isoFromLocal, localDateKey, nowIso } from "@/lib/utils";
import type { DayPlan } from "@/lib/types";

export const dynamic = "force-dynamic";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** isoFromLocal goes through TZDate, whose toISOString() emits an offset form. */
function utcFromLocal(dateLocal: string, time: string, tz: string): string {
  return new Date(isoFromLocal(dateLocal, time, tz)).toISOString();
}

const blockSchema = z.object({
  start: z.string().regex(TIME, "start must be HH:mm"),
  end: z.string().regex(TIME, "end must be HH:mm"),
  label: z.string().trim().min(1),
  taskIds: z.array(z.string()).default([]),
  kind: z.enum(["focus", "break", "errand", "event"]),
});

const bodySchema = z.object({
  blocks: z.array(blockSchema),
  addToCalendar: z.boolean().optional(),
});

export async function POST(req: Request): Promise<Response> {
  const gate = await requireSession();
  if (gate) return gate;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 }
    );
  }

  const tz = settingsRepo.getApp().tz;
  const dateLocal = localDateKey(new Date(), tz);
  const existing = plansRepo.get(dateLocal);

  const plan: DayPlan = {
    dateLocal,
    summary: existing?.summary ?? "",
    blocks: parsed.data.blocks,
    accepted: true,
    generatedAt: existing?.generatedAt ?? nowIso(),
  };
  plansRepo.save(plan);

  if (!parsed.data.addToCalendar) return NextResponse.json({ plan });

  let calendarAdded = 0;
  for (const block of plan.blocks) {
    if (block.kind !== "focus" && block.kind !== "errand") continue;
    try {
      await createEventOnCalendar({
        title: `DoneX · ${block.label}`,
        start: utcFromLocal(dateLocal, block.start, tz),
        end: utcFromLocal(dateLocal, block.end, tz),
      });
      calendarAdded++;
    } catch {
      // a disconnected calendar must not fail accepting the plan
    }
  }

  return NextResponse.json({ plan, calendarAdded });
}
