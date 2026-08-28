/** Who am I: role + display names, so the shell can shape itself. */
import { NextResponse } from "next/server";
import { sessionRole } from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

export async function GET() {
  const role = await sessionRole();
  if (!role) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const joint = settingsRepo.getApp().joint;
  return NextResponse.json({
    role,
    jointEnabled: !!joint.partnerPinHash,
    ownerName: joint.ownerName || "Me",
    partnerName: joint.partnerName || "Partner",
  });
}
