/**
 * The merged couple calendar: owner's Google Calendar (or ICS feed), the
 * partner's ICS feed, and dated joint tasks — one week, both roles. Feed
 * failures degrade to a named warning instead of failing the whole view.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { settingsRepo, tasksRepo } from "@/lib/db/repos";
import { listEventsRange } from "@/lib/google/calendar";
import { icsEventsBetween } from "@/lib/ics";
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
  const days = clamp(Number(req.nextUrl.searchParams.get("days")) || 7, 1, 14);
  const todayKey = localDateKey(new Date(), tz);
  const fromIso = isoFromLocal(todayKey, "00:00", tz);
  const toIso = isoFromLocal(addDaysToDateKey(todayKey, days), "00:00", tz);
  const from = new Date(fromIso);
  const to = new Date(toIso);

  const events: JointCalendarEntry[] = [];
  const warnings: string[] = [];
  const joint = settings.joint;

  // Owner side: explicit ICS feed wins, else the Google connection.
  if (joint.ownerIcsUrl) {
    try {
      for (const e of await icsEventsBetween({ url: joint.ownerIcsUrl, from, to })) {
        events.push({ ...e, who: "owner" });
      }
    } catch {
      warnings.push(`${joint.ownerName || "Your"} calendar feed is unreachable`);
    }
  } else {
    try {
      for (const e of await listEventsRange(fromIso, toIso)) {
        events.push({ ...e, who: "owner" });
      }
    } catch {
      warnings.push("Google Calendar is unreachable");
    }
  }

  if (joint.partnerIcsUrl) {
    try {
      for (const e of await icsEventsBetween({ url: joint.partnerIcsUrl, from, to })) {
        events.push({ ...e, who: "partner" });
      }
    } catch {
      warnings.push(`${joint.partnerName || "Partner"} calendar feed is unreachable`);
    }
  }

  events.sort((a, b) => a.start.localeCompare(b.start));

  // Dated joint tasks ride along so "pick up the cake sat 2pm" shows here too.
  const tasks = tasksRepo
    .list({ space: "joint" })
    .filter((t) => t.dueAt !== null && t.dueAt < toIso)
    .slice(0, 50);

  return NextResponse.json({ events, tasks, warnings, days, from: fromIso, to: toIso });
}
