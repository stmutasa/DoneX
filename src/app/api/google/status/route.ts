import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { googleRepo } from "@/lib/db/repos";
import { googleConfigured } from "@/lib/google/oauth";
import { lastScanState } from "@/lib/google/gmail";
import type { GoogleStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireSession();
  if (gate) return gate;

  const tokens = googleRepo.get();
  const status: GoogleStatus = {
    configured: googleConfigured(),
    connected: !!tokens,
    email: tokens?.email || null,
    scopes: tokens?.scopes ?? [],
    gmailScan: lastScanState(),
  };
  return NextResponse.json(status);
}
