import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { aiConfigured, generateBriefing } from "@/lib/ai";
import { settingsRepo } from "@/lib/db/repos";
import { localDateKey } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const gate = await requireSession();
  if (gate) return gate;
  if (!aiConfigured()) return NextResponse.json({ error: "AI not configured" }, { status: 409 });

  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const tz = settingsRepo.getApp().tz;
  const dateLocal = localDateKey(new Date(), tz);

  try {
    const briefing = await generateBriefing(dateLocal, { force: refresh });
    return NextResponse.json({ briefing });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not generate the briefing";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
