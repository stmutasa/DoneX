import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { currentSession, requireSession } from "@/lib/auth";
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

  // Read the session again right before the write: it may have been signed
  // out while the body arrived, and a missing role must never become
  // "owner". The row is tagged with whoever is signed in now and linked to
  // this session, so it follows the person using the device and goes away
  // when they sign out.
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  pushRepo.add(parsed.data.subscription, session.role, session.token);
  return NextResponse.json({ ok: true });
}
