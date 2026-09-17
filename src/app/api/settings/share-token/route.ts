/**
 * Minting and retiring the read-only feed link. POST hands back a new token
 * — which is also how you rotate, since the old one stops working the moment
 * this returns. DELETE turns the link off entirely.
 */
import crypto from "crypto";
import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

export async function POST() {
  const gate = await requireOwner();
  if (gate) return gate;

  const shareToken = crypto.randomBytes(24).toString("base64url");
  settingsRepo.updateApp({ shareToken });
  return NextResponse.json({ shareToken });
}

export async function DELETE() {
  const gate = await requireOwner();
  if (gate) return gate;

  settingsRepo.updateApp({ shareToken: "" });
  return NextResponse.json({ shareToken: "" });
}
