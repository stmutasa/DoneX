import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Also serves as the version probe clients poll to detect a new deploy. */
export async function GET() {
  return NextResponse.json(
    { ok: true, version: process.env.NEXT_PUBLIC_BUILD_ID ?? "dev" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
