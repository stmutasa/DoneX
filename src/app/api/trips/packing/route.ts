/**
 * Turn the next trip into a packing checklist you can tick off. It lands in
 * Notes as a normal list — nothing about it is special afterwards.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { notesRepo, settingsRepo } from "@/lib/db/repos";
import { ownerTrips } from "@/lib/jointFeeds";
import { PACKING_NOTICE_DAYS, activeTrip, packingList, upcomingTrip } from "@/lib/trips";
import { format } from "date-fns";
import { keyToDate } from "@/lib/format";
import { localDateKey, newId } from "@/lib/utils";

export const dynamic = "force-dynamic";

/** `start` names the trip the card is showing; without it, the card's own pick. */
const BodySchema = z.object({ start: z.string().max(64).optional() });

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const body = BodySchema.safeParse(await req.json().catch(() => ({})));
  const wanted = body.success ? body.data.start : undefined;

  // Same window and detection as GET /api/trips, so this packs the trip the
  // card shows: the one you're on, else the next one.
  const settings = settingsRepo.getApp();
  const now = new Date();
  const { trips } = await ownerTrips(settings, now);
  const trip =
    (wanted ? trips.find((t) => t.start === wanted) : undefined) ??
    activeTrip(trips, now) ??
    upcomingTrip(trips, PACKING_NOTICE_DAYS, now);
  if (!trip) {
    return NextResponse.json({ error: "No trip on the calendar to pack for" }, { status: 404 });
  }

  // A trip nothing names is told apart by the day it starts.
  const title = trip.destination
    ? `Packing — ${trip.destination}`
    : `Packing — trip on ${format(keyToDate(trip.startDay ?? localDateKey(trip.start, settings.tz)), "MMM d")}`;
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
