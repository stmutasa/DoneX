import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { mapsConfigured, searchPlaces } from "@/lib/google/places";

export const dynamic = "force-dynamic";

/** A missing or blank param is no coordinate — `Number(null)` would be 0. */
function coord(raw: string | null): number {
  return raw === null || raw.trim() === "" ? NaN : Number(raw);
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  if (!mapsConfigured()) {
    return NextResponse.json({ error: "Maps API key not configured" }, { status: 409 });
  }

  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ places: [] });

  // No fix means an unbiased search, not one centred on 0,0.
  const lat = coord(req.nextUrl.searchParams.get("lat"));
  const lng = coord(req.nextUrl.searchParams.get("lng"));
  const near = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;

  try {
    return NextResponse.json({ places: await searchPlaces(q, near) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Place search failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
