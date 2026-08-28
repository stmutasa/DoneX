/**
 * Owner-only: set or clear the partner PIN that opens the joint list.
 * Setting a new PIN also signs out existing partner sessions, so a rotated
 * PIN takes effect immediately on the other phone.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { hashPin, requireOwner } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { settingsRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  pin: z.string().regex(/^\d{4,8}$/, "PIN must be 4-8 digits").nullable(),
});

export async function POST(req: Request) {
  const gate = await requireOwner();
  if (gate) return gate;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid PIN" },
      { status: 400 },
    );
  }

  const owner = settingsRepo.getApp().pinHash;
  if (parsed.data.pin !== null && owner) {
    const { verifyPin } = await import("@/lib/auth");
    if (verifyPin(parsed.data.pin, owner)) {
      return NextResponse.json(
        { error: "That's your own PIN — pick a different one for your partner" },
        { status: 400 },
      );
    }
  }

  settingsRepo.updateApp({
    joint: { partnerPinHash: parsed.data.pin === null ? "" : hashPin(parsed.data.pin) },
  });
  getDb().prepare("DELETE FROM sessions WHERE role='partner'").run();
  return NextResponse.json({ ok: true, enabled: parsed.data.pin !== null });
}
