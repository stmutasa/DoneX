/** Who am I: role + display names, so the shell can shape itself. */
import { NextResponse } from "next/server";
import { sessionRole } from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

export async function GET() {
  const role = await sessionRole();
  if (!role) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const settings = settingsRepo.getApp();
  const joint = settings.joint;
  return NextResponse.json({
    role,
    // The shell hides what is switched off, and the switched-off pages send
    // you back to Today — both read this rather than the owner-only settings.
    features: settings.features,
    jointEnabled: !!joint.partnerPinHash,
    ownerName: joint.ownerName || "Me",
    partnerName: joint.partnerName || "Partner",
    ownerColor: joint.ownerColor || "blue",
    partnerColor: joint.partnerColor || "pink",
  });
}
