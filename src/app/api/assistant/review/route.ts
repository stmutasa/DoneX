import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { aiConfigured, generateWeeklyReview } from "@/lib/ai";
import { settingsRepo } from "@/lib/db/repos";
import { isoWeekKey } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const gate = await requireOwner();
  if (gate) return gate;
  if (!aiConfigured()) return NextResponse.json({ error: "AI not configured" }, { status: 409 });

  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const tz = settingsRepo.getApp().tz;
  const weekKey = isoWeekKey(new Date(), tz);

  try {
    const review = await generateWeeklyReview(weekKey, { force: refresh });
    return NextResponse.json({ review });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not generate the review";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
