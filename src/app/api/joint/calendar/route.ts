/**
 * The merged couple calendar: each person's calendar (a pasted ICS feed, a
 * Google calendar shared with the owner, or the owner's own Google) plus dated
 * joint tasks — one week, both roles. A feed that fails degrades to a warning
 * naming what went wrong, instead of failing the whole view.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { settingsRepo, tasksRepo } from "@/lib/db/repos";
import { ownerEvents, partnerEvents } from "@/lib/jointFeeds";
import { addDaysToDateKey, clamp, isoFromLocal, localDateKey } from "@/lib/utils";
import type { CalendarEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

export interface JointCalendarEntry extends CalendarEvent {
  who: "owner" | "partner";
}

export async function GET(req: NextRequest) {
  const gate = await requireSession();
  if (gate) return gate;

  const settings = settingsRepo.getApp();
  const tz = settings.tz;
  // A navigable window: `from` is a local date key, defaulting to today, and
  // `days` stretches to a month grid's 42 cells.
  const days = clamp(Number(req.nextUrl.searchParams.get("days")) || 7, 1, 45);
  const todayKey = localDateKey(new Date(), tz);
  const requested = req.nextUrl.searchParams.get("from") ?? "";
  const startKey = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : todayKey;
  const fromIso = isoFromLocal(startKey, "00:00", tz);
  const toIso = isoFromLocal(addDaysToDateKey(startKey, days), "00:00", tz);

  const events: JointCalendarEntry[] = [];
  const warnings: string[] = [];
  const joint = settings.joint;
  const window = { fromIso, toIso };

  const [mine, theirs] = await Promise.all([
    ownerEvents(joint, window),
    partnerEvents(joint, window),
  ]);

  for (const [who, result] of [["owner", mine], ["partner", theirs]] as const) {
    for (const e of result.events) events.push({ ...e, id: `${who}:${e.id}`, who });
    if (result.warning) warnings.push(result.warning);
  }

  events.sort((a, b) => a.start.localeCompare(b.start));

  // Dated joint tasks ride along so "pick up the cake sat 2pm" shows here too.
  const tasks = tasksRepo
    .list({ space: "joint" })
    .filter((t) => t.dueAt !== null && t.dueAt >= fromIso && t.dueAt < toIso)
    .slice(0, 50);

  return NextResponse.json({ events, tasks, warnings, days, from: fromIso, to: toIso });
}
