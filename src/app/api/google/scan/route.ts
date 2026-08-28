import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { isGoogleConnected } from "@/lib/google/oauth";
import { scanGmail } from "@/lib/google/gmail";

export const dynamic = "force-dynamic";

export async function POST() {
  const gate = await requireOwner();
  if (gate) return gate;

  if (!isGoogleConnected()) {
    return NextResponse.json({ error: "Google is not connected" }, { status: 409 });
  }

  try {
    const created = await scanGmail();
    return NextResponse.json({ created });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Gmail scan failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
