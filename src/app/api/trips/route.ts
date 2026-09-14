/**
 * Trips read out of the calendar. The owner gets the detail; a partner
 * session gets only "away or not", which is the part that concerns them.
 */
import { NextResponse } from "next/server";
import { requireSession, sessionRole } from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";
import { ownerEvents } from "@/lib/jointFeeds";
import {
  PACKING_NOTICE_DAYS,
  activeTrip,
  detectTrips,
  packingList,
  upcomingTrip,
} from "@/lib/trips";
import { addDaysToDateKey, isoFromLocal, localDateKey } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireSession();
  if (gate) return gate;
  const role = (await sessionRole()) ?? "owner";

  const settings = settingsRepo.getApp();
  const tz = settings.tz;
  const todayKey = localDateKey(new Date(), tz);
  const window = {
    fromIso: isoFromLocal(addDaysToDateKey(todayKey, -2), "00:00", tz),
    toIso: isoFromLocal(addDaysToDateKey(todayKey, 45), "00:00", tz),
  };

  const { events, warning } = await ownerEvents(settings.joint, window);
  const trips = detectTrips(events);
  const now = new Date();
  const active = activeTrip(trips, now);
  const upcoming = upcomingTrip(trips, PACKING_NOTICE_DAYS, now);

  // The partner is told where you are and when you're back — nothing else.
  if (role === "partner") {
    return NextResponse.json({
      away: active
        ? { destination: active.destination, until: active.end, who: settings.joint.ownerName || "They" }
        : null,
    });
  }

  return NextResponse.json({
    active,
    upcoming,
    upcomingPacking: upcoming ? packingList(upcoming) : [],
    calendarWarning: warning,
  });
}
