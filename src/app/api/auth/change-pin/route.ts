import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { currentSession, endSessions, hashPin, requireOwner, verifyPin } from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  pin: z.string().regex(/^\d{4,8}$/, "PIN must be 4-8 digits"),
});

/**
 * Single-user app: an authenticated session may set a new PIN without the old
 * one (whoever holds an unlocked session already has full access, and this is
 * the recovery path when the PIN is forgotten but a device is still signed in).
 * Every other owner session is signed out, so a PIN changed because someone
 * saw it locks that person out straight away.
 */
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  // Sign-in tries the owner's PIN first, so a shared PIN would let the
  // partner in as the owner.
  const partnerPinHash = settingsRepo.getApp().joint.partnerPinHash;
  if (partnerPinHash && verifyPin(parsed.data.pin, partnerPinHash)) {
    return NextResponse.json(
      { error: "That's your partner's PIN — pick a different one" },
      { status: 400 },
    );
  }

  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  settingsRepo.updateApp({ pinHash: hashPin(parsed.data.pin) });
  endSessions("owner", session.token);
  return NextResponse.json({ ok: true });
}
