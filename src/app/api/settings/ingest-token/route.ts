/**
 * Rotate the SMS capture token. Any automation still holding the old token
 * starts getting 401s immediately — the hard revoke when a phone is lost or
 * a macro can't be reached.
 */
import crypto from "crypto";
import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

export async function POST() {
  const gate = await requireOwner();
  if (gate) return gate;

  const ingestToken = crypto.randomBytes(12).toString("hex");
  settingsRepo.updateApp({ ingestToken });
  return NextResponse.json({ ingestToken });
}
