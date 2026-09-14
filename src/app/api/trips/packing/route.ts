/**
 * Turn the next trip into a packing checklist you can tick off. It lands in
 * Notes as a normal list — nothing about it is special afterwards.
 */
import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { notesRepo, settingsRepo } from "@/lib/db/repos";
import { ownerEvents } from "@/lib/jointFeeds";
import {
  PACKING_NOTICE_DAYS,
  activeTrip,
  detectTrips,
  packingList,
  upcomingTrip,
} from "@/lib/trips";
import { addDaysToDateKey, isoFromLocal, localDateKey, newId } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function POST() {
  const gate = await requireOwner();
  if (gate) return gate;

  const settings = settingsRepo.getApp();
  const tz = settings.tz;
  const todayKey = localDateKey(new Date(), tz);
  const { events } = await ownerEvents(settings.joint, {
    fromIso: isoFromLocal(todayKey, "00:00", tz),
    toIso: isoFromLocal(addDaysToDateKey(todayKey, 45), "00:00", tz),
  });

  const trips = detectTrips(events);
  const now = new Date();
  const trip = upcomingTrip(trips, PACKING_NOTICE_DAYS, now) ?? activeTrip(trips, now);
  if (!trip) {
    return NextResponse.json({ error: "No trip on the calendar to pack for" }, { status: 404 });
  }

  const title = `Packing — ${trip.destination}`;
  const items = packingList(trip).map((text) => ({ id: newId(), text, done: false }));

  // Adding to an existing list beats making a second one with the same name.
  const existing = notesRepo.findByTitle(title);
  if (existing) {
    const have = new Set(existing.items.map((i) => i.text.toLowerCase()));
    const additions = items.filter((i) => !have.has(i.text.toLowerCase()));
    const note = notesRepo.update(existing.id, { items: [...existing.items, ...additions] });
    return NextResponse.json({ ok: true, noteId: existing.id, added: additions.length, note });
  }

  const note = notesRepo.create({ title, kind: "checklist", items, pinned: true });
  return NextResponse.json({ ok: true, noteId: note.id, added: items.length, note });
}
