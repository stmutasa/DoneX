/**
 * "Test" for a joint-calendar source (owner-only). Runs the exact same
 * resolution the joint calendar does over the next 7 days and reports what
 * came back — so a wrong link explains itself here instead of turning into a
 * warning on the Ours tab later.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";
import { ownerEvents, partnerEvents } from "@/lib/jointFeeds";
import { addDaysToDateKey, isoFromLocal, localDateKey } from "@/lib/utils";

export const dynamic = "force-dynamic";

const BodySchema = z.object({ side: z.enum(["owner", "partner"]) });

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Expected {side}" }, { status: 400 });

  const settings = settingsRepo.getApp();
  const joint = settings.joint;
  const todayKey = localDateKey(new Date(), settings.tz);
  const window = {
    fromIso: isoFromLocal(todayKey, "00:00", settings.tz),
    toIso: isoFromLocal(addDaysToDateKey(todayKey, 7), "00:00", settings.tz),
  };

  const result =
    parsed.data.side === "owner"
      ? await ownerEvents(joint, window)
      : await partnerEvents(joint, window);

  if (result.source === "none") {
    return NextResponse.json({
      ok: false,
      source: result.source,
      count: 0,
      message: "Nothing is set up for this calendar yet.",
    });
  }

  if (result.warning) {
    return NextResponse.json({ ok: false, source: result.source, count: 0, message: result.warning });
  }

  const count = result.events.length;
  const how =
    result.source === "google-shared"
      ? "shared Google calendar"
      : result.source === "ics"
        ? "calendar link"
        : "your Google calendar";
  return NextResponse.json({
    ok: true,
    source: result.source,
    count,
    message:
      count > 0
        ? `Connected — ${count} event${count === 1 ? "" : "s"} in the next 7 days from the ${how}.`
        : `Connected to the ${how}, but there's nothing scheduled in the next 7 days.`,
  });
}
