import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth";
import { buildAuthorizeUrl, googleConfigured } from "@/lib/google/oauth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  if (!googleConfigured()) {
    return NextResponse.json(
      { error: "Add your Google client ID and secret in Settings first" },
      { status: 400 }
    );
  }

  try {
    return NextResponse.redirect(buildAuthorizeUrl(request), 302);
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 400 });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Could not start Google authorization";
}
