/**
 * Your own morning-digest schedule for the shared list.
 *
 * Both people reach this one, and each can only see and change their own
 * setting — the partner has no way into Settings, so without this she could
 * never move her own alarm.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession, sessionRole } from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";
import { isValidTime, normalizeTime } from "@/lib/jointDigest";
import type { SessionRole } from "@/lib/types";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  enabled: z.boolean().optional(),
  time: z.string().optional(),
});

function scheduleOf(role: SessionRole) {
  const joint = settingsRepo.getApp().joint;
  return role === "owner"
    ? { enabled: joint.ownerDigestEnabled, time: normalizeTime(joint.ownerDigestTime) }
    : { enabled: joint.partnerDigestEnabled, time: normalizeTime(joint.partnerDigestTime) };
}

export async function GET() {
  const gate = await requireSession();
  if (gate) return gate;
  const role = (await sessionRole()) ?? "owner";
  return NextResponse.json({ role, ...scheduleOf(role) });
}

export async function PATCH(req: NextRequest) {
  const gate = await requireSession();
  if (gate) return gate;
  const role = (await sessionRole()) ?? "owner";

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const { enabled, time } = parsed.data;

  if (time !== undefined && !isValidTime(time)) {
    return NextResponse.json({ error: "Expected a time like 07:00" }, { status: 400 });
  }

  // Whichever role is asking, only that person's two fields can move.
  const patch: Record<string, unknown> = {};
  if (enabled !== undefined) {
    patch[role === "owner" ? "ownerDigestEnabled" : "partnerDigestEnabled"] = enabled;
  }
  if (time !== undefined) {
    patch[role === "owner" ? "ownerDigestTime" : "partnerDigestTime"] = normalizeTime(time);
  }
  if (Object.keys(patch).length > 0) settingsRepo.updateApp({ joint: patch });

  return NextResponse.json({ role, ...scheduleOf(role) });
}
