/**
 * Trips read out of the calendar. The owner gets the detail; a partner
 * session gets only "away or not", which is the part that concerns them.
 */
import { NextResponse } from "next/server";
import { requireSession, sessionRole } from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";
import { ownerTrips } from "@/lib/jointFeeds";
import {
  PACKING_NOTICE_DAYS,
  activeTrip,
  packingList,
  upcomingTrip,
  zoneOffsetMinutes,
} from "@/lib/trips";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireSession();
  if (gate) return gate;
  const role = (await sessionRole()) ?? "owner";

  const settings = settingsRepo.getApp();
  const now = new Date();
  const { trips, warning } = await ownerTrips(settings, now);
  const active = activeTrip(trips, now);
  const upcoming = upcomingTrip(trips, PACKING_NOTICE_DAYS, now);

  // The partner is told where you are and when you're back — nothing else.
  // `untilDay` is set when the trip ends on an all-day booking, which has a
  // date but no time.
  if (role === "partner") {
    return NextResponse.json({
      away: active
        ? {
            destination: active.destination,
            until: active.end,
            untilDay: active.endDay ?? null,
            who: settings.joint.ownerName || "They",
          }
        : null,
    });
  }

  return NextResponse.json({
    active,
    upcoming,
    upcomingPacking: upcoming ? packingList(upcoming) : [],
    calendarWarning: warning,
    // Home is the account's zone, not wherever the phone's clock has moved to.
    homeOffsetMinutes: zoneOffsetMinutes(settings.tz, now),
  });
}
