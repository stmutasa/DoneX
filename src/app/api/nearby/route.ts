import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { tasksRepo } from "@/lib/db/repos";
import { haversineKm } from "@/lib/utils";
import type { NearbyTask } from "@/lib/types";

export const dynamic = "force-dynamic";

/** A missing or blank param is no coordinate — `Number(null)` would be 0. */
function coord(raw: string | null): number {
  return raw === null || raw.trim() === "" ? NaN : Number(raw);
}

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const lat = coord(req.nextUrl.searchParams.get("lat"));
  const lng = coord(req.nextUrl.searchParams.get("lng"));
  const located = tasksRepo.located();

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    // No position: still return the errand list, unsorted, distance unknown.
    const tasks: NearbyTask[] = located.map((task) => ({ task, distanceKm: -1 }));
    return NextResponse.json({ tasks, located: located.length });
  }

  const here = { lat, lng };
  const tasks: NearbyTask[] = located
    .map((task) => ({ task, distanceKm: haversineKm(here, task.location!) }))
    .sort((a, b) => a.distanceKm - b.distanceKm);
  return NextResponse.json({ tasks, located: located.length });
}
