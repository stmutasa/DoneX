import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { aiConfigured, generateDayPlan } from "@/lib/ai";
import { settingsRepo } from "@/lib/db/repos";
import { localDateKey } from "@/lib/utils";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ refresh: z.boolean().optional() });

export async function POST(req: Request): Promise<Response> {
  const gate = await requireSession();
  if (gate) return gate;
  if (!aiConfigured()) return NextResponse.json({ error: "AI not configured" }, { status: 409 });

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = bodySchema.safeParse(raw ?? {});
  const refresh = parsed.success ? (parsed.data.refresh ?? false) : false;

  const tz = settingsRepo.getApp().tz;
  const dateLocal = localDateKey(new Date(), tz);

  try {
    const plan = await generateDayPlan(dateLocal, { force: refresh });
    return NextResponse.json({ plan });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not generate the plan";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
