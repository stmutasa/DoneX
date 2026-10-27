/** Who am I: role + display names, so the shell can shape itself. */
import { NextResponse } from "next/server";
import { pinsCollide, rememberOwnerDevice, sessionRole } from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

export async function GET() {
  const role = await sessionRole();
  if (!role) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // The shell asks this on every load, so an owner device becomes (and stays)
  // one the login limiter recognises.
  if (role === "owner") await rememberOwnerDevice();
  const settings = settingsRepo.getApp();
  const joint = settings.joint;
  return NextResponse.json({
    role,
    // Only the owner can fix it, so only the owner's shell asks them to.
    pinCollision: role === "owner" && pinsCollide(),
    // The shell hides what is switched off, and the switched-off pages send
    // you back to Today — both read this rather than the owner-only settings.
    features: settings.features,
    // All-day dates are midnight in this zone; a partner can't read settings.
    tz: settings.tz,
    jointEnabled: !!joint.partnerPinHash,
    ownerName: joint.ownerName || "Me",
    partnerName: joint.partnerName || "Partner",
    ownerColor: joint.ownerColor || "blue",
    partnerColor: joint.partnerColor || "pink",
  });
}
