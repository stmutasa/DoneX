import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { ensureVapid } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireSession();
  if (gate) return gate;

  const { publicKey } = ensureVapid();
  return NextResponse.json({ publicKey });
}
