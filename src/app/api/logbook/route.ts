import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { completionsRepo, settingsRepo } from "@/lib/db/repos";
import { addDaysToDateKey, clamp, localDateKey } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await requireSession();
  if (gate) return gate;

  const days = clamp(Number(req.nextUrl.searchParams.get("days")) || 30, 1, 365);
  const tz = settingsRepo.getApp().tz;
  const today = localDateKey(new Date(), tz);
  const from = addDaysToDateKey(today, -(days - 1));

  return NextResponse.json({ days: completionsRepo.logbook(from, today) });
}
