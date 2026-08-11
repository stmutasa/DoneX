import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";
import { nowIso } from "@/lib/utils";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

/** Clients report their position here so briefings and voice sessions can be
 *  location-aware server-side. Only the latest fix is kept. */
export async function POST(req: NextRequest) {
  const gate = await requireSession();
  if (gate) return gate;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid coordinates" }, { status: 400 });
  }

  settingsRepo.updateApp({ lastLocation: { ...parsed.data, at: nowIso() } });
  return NextResponse.json({ ok: true });
}
