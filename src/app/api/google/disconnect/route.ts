import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { googleRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

export async function POST() {
  const gate = await requireOwner();
  if (gate) return gate;

  googleRepo.clear();
  return NextResponse.json({ ok: true });
}
