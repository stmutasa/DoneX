import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hashPin, requireSession } from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  pin: z.string().regex(/^\d{4,8}$/, "PIN must be 4-8 digits"),
});

/**
 * Single-user app: an authenticated session may set a new PIN without the old
 * one (whoever holds an unlocked session already has full access, and this is
 * the recovery path when the PIN is forgotten but a device is still signed in).
 */
export async function POST(req: NextRequest) {
  const gate = await requireSession();
  if (gate) return gate;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  settingsRepo.updateApp({ pinHash: hashPin(parsed.data.pin) });
  return NextResponse.json({ ok: true });
}
