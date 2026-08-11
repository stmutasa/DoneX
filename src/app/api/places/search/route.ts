import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { mapsConfigured, searchPlaces } from "@/lib/google/places";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await requireSession();
  if (gate) return gate;

  if (!mapsConfigured()) {
    return NextResponse.json({ error: "Maps API key not configured" }, { status: 409 });
  }

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ places: [] });

  const lat = Number(req.nextUrl.searchParams.get("lat"));
  const lng = Number(req.nextUrl.searchParams.get("lng"));
  const near = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;

  try {
    return NextResponse.json({ places: await searchPlaces(q, near) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Place search failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
