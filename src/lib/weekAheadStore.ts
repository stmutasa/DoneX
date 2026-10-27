/**
 * Server side of the Sunday week-ahead: building one, and keeping the last
 * one so it can be read again after the notification is swiped away.
 *
 * Both the scheduler and the route go through here, so what lands on the
 * phone Sunday evening and what the "send me one now" button produces are
 * built by exactly the same code.
 */
import "server-only";
import { generateWeekAhead } from "@/lib/ai";
import { settingsRepo } from "@/lib/db/repos";
import { ownerEvents, partnerEvents } from "@/lib/jointFeeds";
import { isoFromLocal } from "@/lib/utils";
import {
  kvLastWeekAhead,
  parseLastWeekAhead,
  weekWindow,
  type LastWeekAhead,
} from "@/lib/weekAhead";
import type { AppSettings, CalendarEvent, SessionRole } from "@/lib/types";

export type { LastWeekAhead } from "@/lib/weekAhead";

/** The week key the scheduler claimed, as the build before v1.33.0 wrote it. */
export const kvLastWeekAheadWeek = (role: SessionRole) => `sched.lastWeekAhead.${role}`;

export function readLastWeekAhead(role: SessionRole): LastWeekAhead | null {
  return parseLastWeekAhead(settingsRepo.getKV(kvLastWeekAhead(role)));
}

export function writeLastWeekAhead(role: SessionRole, entry: LastWeekAhead): void {
  settingsRepo.setKV(kvLastWeekAhead(role), JSON.stringify(entry));
}

/**
 * Both calendars for the coming Monday-to-Sunday. The shared calendar is a
 * surface they both already see, so neither side is hidden from the other —
 * unlike the task lists, which stay per-person.
 */
export async function weekEvents(
  settings: AppSettings,
  todayKey: string,
): Promise<{ events: CalendarEvent[]; weekOf: string }> {
  const tz = settings.tz;
  const { fromKey, toKey } = weekWindow(todayKey);
  const window = {
    fromIso: isoFromLocal(fromKey, "00:00", tz),
    toIso: isoFromLocal(toKey, "00:00", tz),
  };

  const [mine, theirs] = await Promise.all([
    ownerEvents(settings.joint, window),
    partnerEvents(settings.joint, window),
  ]);
  return { events: [...mine.events, ...theirs.events], weekOf: fromKey };
}

/** The finished text for one person, or "" when their week is empty. */
export async function buildWeekAhead(
  role: SessionRole,
  todayKey: string,
): Promise<{ text: string; weekOf: string }> {
  const settings = settingsRepo.getApp();
  let events: CalendarEvent[] = [];
  let weekOf = weekWindow(todayKey).fromKey;
  try {
    const found = await weekEvents(settings, todayKey);
    events = found.events;
    weekOf = found.weekOf;
  } catch (err) {
    // A dead calendar feed shouldn't cost you the task half of the summary.
    console.error("[weekAhead] calendars", err);
  }

  const text = await generateWeekAhead(role, events, weekOf);
  if (text) writeLastWeekAhead(role, { text, weekOf, at: new Date().toISOString() });
  return { text, weekOf };
}
