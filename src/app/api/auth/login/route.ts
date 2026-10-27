import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  DEVICE_COOKIE,
  claimLoginAttempt,
  createSession,
  loginClient,
  verifyPin,
} from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";
import { sendPushToAll } from "@/lib/push";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ pin: z.string().min(1) });

function waitText(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 1) return "a minute";
  if (minutes <= 60) return `${minutes} minutes`;
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "an hour" : `${hours} hours`;
}

export async function POST(req: NextRequest) {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  // From the claim to settle() nothing awaits, and the claim counts the try
  // before any PIN is checked, so parallel requests can't share one count.
  const client = loginClient(
    req.cookies.get(DEVICE_COOKIE)?.value,
    req.headers.get("x-forwarded-for"),
    req.headers.get("x-real-ip"),
  );
  const attempt = claimLoginAttempt(client);
  if ("retryAfter" in attempt) {
    return NextResponse.json(
      { error: `Too many tries. Try again in ${waitText(attempt.retryAfter)}.` },
      { status: 429, headers: { "Retry-After": String(attempt.retryAfter) } },
    );
  }

  const settings = settingsRepo.getApp();
  const pin = parsed.data.pin;
  const owner = !!settings.pinHash && verifyPin(pin, settings.pinHash);
  const partner = !!settings.joint.partnerPinHash && verifyPin(pin, settings.joint.partnerPinHash);
  // One PIN opening both can only predate the checks that now keep them
  // apart. There's no telling who typed it, so neither door opens.
  const role: "owner" | "partner" | null = owner && partner ? null : owner ? "owner" : partner ? "partner" : null;
  if (owner && partner) console.warn("[auth] the owner and partner PINs are the same; sign-in refused");

  if (attempt.settle(role)) {
    void sendPushToAll(
      {
        title: "DoneX",
        body: "Someone keeps entering the wrong PIN. Sign-in is paused for now, except on devices you’ve signed in on before.",
        url: "/today",
      },
      ["owner"],
    );
  }
  if (!role) return NextResponse.json({ error: "Incorrect PIN" }, { status: 401 });

  await createSession(role);
  return NextResponse.json({ ok: true, role });
}
