import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireSession, sessionRole } from "@/lib/auth";
import { pushRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  subscription: z.object({
    endpoint: z.string().min(1),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1),
    }),
  }),
});

export async function POST(request: NextRequest) {
  const gate = await requireSession();
  if (gate) return gate;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid push subscription" }, { status: 400 });
  }

  pushRepo.add(parsed.data.subscription, (await sessionRole()) ?? "owner");
  return NextResponse.json({ ok: true });
}
