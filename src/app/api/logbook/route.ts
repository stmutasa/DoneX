import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { completionsRepo, settingsRepo, tasksRepo } from "@/lib/db/repos";
import { addDaysToDateKey, clamp, localDateKey } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const days = clamp(Number(req.nextUrl.searchParams.get("days")) || 30, 1, 365);
  const tz = settingsRepo.getApp().tz;
  const today = localDateKey(new Date(), tz);
  const from = addDaysToDateKey(today, -(days - 1));

  return NextResponse.json({ days: completionsRepo.logbook(from, today) });
}

/** Take the one entry that was tapped back out of the log (?id=<entry id>). */
export async function DELETE(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Missing entry id" }, { status: 400 });
  }
  const result = tasksRepo.unlog(id);
  // Already gone (another device got there first): nothing left to do.
  if (!result) return NextResponse.json({ removed: false, task: null, reopened: false });
  if (!result.task) {
    return NextResponse.json(
      { error: "That task no longer exists, so there's nothing to restore" },
      { status: 404 }
    );
  }
  return NextResponse.json(result);
}
