import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { z } from "zod";
import { createSession, hashPin } from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";
import { nowIso } from "@/lib/utils";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  pin: z.string().regex(/^\d{4,8}$/, "PIN must be 4-8 digits"),
  tz: z.string().min(1),
});

export async function POST(req: NextRequest) {
  if (settingsRepo.getApp().pinHash) {
    return NextResponse.json({ error: "Already set up" }, { status: 409 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid body" }, { status: 400 });
  }
  const { pin, tz } = parsed.data;

  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    return NextResponse.json({ error: "Invalid timezone" }, { status: 400 });
  }

  // Keep an existing ingest token: a PIN reset that clears pinHash and
  // re-runs setup must not silently break the user's SMS forwarder.
  const existing = settingsRepo.getApp();
  settingsRepo.updateApp({
    pinHash: hashPin(pin),
    tz,
    ingestToken: existing.ingestToken || crypto.randomBytes(12).toString("hex"),
    onboardedAt: existing.onboardedAt ?? nowIso(),
  });
  await createSession();
  return NextResponse.json({ ok: true });
}
