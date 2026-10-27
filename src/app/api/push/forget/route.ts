/**
 * Stop pushing to one browser, for screens with no session: the PIN pad, and
 * just after sign-out. No session is needed because the endpoint URL is
 * itself the capability: only that browser and its push service know it. It
 * removes that one row and says nothing about whether it existed. The browser
 * keeps its subscription, so the next sign-in re-posts it under whoever signs
 * in (owner or partner) without anyone turning notifications on again.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { pushRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  endpoint: z
    .string()
    .max(2048)
    .url()
    .refine((u) => u.startsWith("https://"), "Push endpoints are https"),
});

export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid push endpoint" }, { status: 400 });
  }
  pushRepo.remove(parsed.data.endpoint);
  return NextResponse.json({ ok: true });
}
