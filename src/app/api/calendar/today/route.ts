import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { getTodayEvents } from "@/lib/google/calendar";
import { isGoogleConnected } from "@/lib/google/oauth";
import type { CalendarEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  const connected = isGoogleConnected();
  try {
    const events: CalendarEvent[] = await getTodayEvents();
    return NextResponse.json({ events, connected });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not load calendar";
    console.error("[calendar] today", err);
    return NextResponse.json({ events: [], connected, error: message });
  }
}
