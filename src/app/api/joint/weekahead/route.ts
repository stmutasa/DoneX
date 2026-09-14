/**
 * Your own Sunday week-ahead: the schedule, the last one you were sent, and
 * a button to build one now.
 *
 * Like the morning digest, both roles reach this and each can only see and
 * move their own setting — the partner never gets into Settings, so this is
 * her only way to change hers.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, sessionRole } from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";
import { sendPushToAll } from "@/lib/push";
import { localDateKey } from "@/lib/utils";
import { normalizeWeekTime } from "@/lib/weekAhead";
import { buildWeekAhead, readLastWeekAhead } from "@/lib/weekAheadStore";
import type { SessionRole } from "@/lib/types";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  enabled: z.boolean().optional(),
  time: z.string().optional(),
});

function scheduleOf(role: SessionRole) {
  const joint = settingsRepo.getApp().joint;
  return role === "owner"
    ? {
        enabled: joint.ownerWeekAheadEnabled,
        time: normalizeWeekTime(joint.ownerWeekAheadTime),
      }
    : {
        enabled: joint.partnerWeekAheadEnabled,
        time: normalizeWeekTime(joint.partnerWeekAheadTime),
      };
}

export async function GET() {
  const gate = await requireSession();
  if (gate) return gate;
  const role = (await sessionRole()) ?? "owner";
  return NextResponse.json({ role, ...scheduleOf(role), last: readLastWeekAhead(role) });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireSession();
  if (gate) return gate;
  const role = (await sessionRole()) ?? "owner";

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const { enabled, time } = parsed.data;

  if (time !== undefined && !/^\d{1,2}:\d{2}$/.test(time.trim())) {
    return NextResponse.json({ error: "Expected a time like 18:00" }, { status: 400 });
  }

  // Whichever role is asking, only that person's own two fields can move.
  const patch: Record<string, unknown> = {};
  if (enabled !== undefined) {
    patch[role === "owner" ? "ownerWeekAheadEnabled" : "partnerWeekAheadEnabled"] = enabled;
  }
  if (time !== undefined) {
    patch[role === "owner" ? "ownerWeekAheadTime" : "partnerWeekAheadTime"] =
      normalizeWeekTime(time);
  }
  if (Object.keys(patch).length > 0) settingsRepo.updateApp({ joint: patch });

  return NextResponse.json({ role, ...scheduleOf(role), last: readLastWeekAhead(role) });
}

/** "Send me one now" — the same summary Sunday evening would bring. */
export async function POST() {
  const gate = await requireSession();
  if (gate) return gate;
  const role = (await sessionRole()) ?? "owner";

  const settings = settingsRepo.getApp();
  const { text } = await buildWeekAhead(role, localDateKey(new Date(), settings.tz));
  if (!text) {
    return NextResponse.json({
      ok: true,
      sent: 0,
      text: "",
      message: "Nothing on the shared list or the calendar for next week, so there was nothing to send.",
    });
  }

  const sent = await sendPushToAll(
    { title: "The week ahead", body: text, url: "/joint", tag: "week-ahead-test" },
    [role],
  );
  return NextResponse.json({
    ok: true,
    sent,
    text,
    message: sent > 0 ? "Sent to your phone." : "Built it, but no device is signed up for alerts yet.",
  });
}
