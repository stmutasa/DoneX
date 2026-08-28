import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createSession, loginRateLimited, recordLoginAttempt, verifyPin } from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ pin: z.string().min(1) });

export async function POST(req: NextRequest) {
  if (loginRateLimited()) {
    return NextResponse.json({ error: "Too many attempts, try again shortly" }, { status: 429 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  recordLoginAttempt();
  const settings = settingsRepo.getApp();
  if (settings.pinHash && verifyPin(parsed.data.pin, settings.pinHash)) {
    await createSession("owner");
    return NextResponse.json({ ok: true, role: "owner" });
  }
  if (settings.joint.partnerPinHash && verifyPin(parsed.data.pin, settings.joint.partnerPinHash)) {
    await createSession("partner");
    return NextResponse.json({ ok: true, role: "partner" });
  }
  return NextResponse.json({ error: "Incorrect PIN" }, { status: 401 });
}
