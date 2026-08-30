/**
 * Resolving each person's calendar for the joint view.
 *
 * Three ways in, in priority order per person:
 *   1. a pasted ICS feed (iCloud public link, or a Google *secret* address)
 *   2. a Google calendar shared with the owner's connected account — read
 *      through that connection, so nothing is published anywhere
 *   3. (owner only) the owner's own Google calendar
 *
 * Both the joint calendar route and the Settings "Test" button go through
 * here, so what the test reports is exactly what the calendar will do.
 */
import "server-only";
import { explainFeedFailure } from "@/lib/calendarLinks";
import { GoogleCalendarError, listEventsRange } from "@/lib/google/calendar";
import { IcsFetchError, icsEventsBetween } from "@/lib/ics";
import { isGoogleConnected } from "@/lib/google/oauth";
import type { CalendarEvent, JointSettings } from "@/lib/types";

export type FeedSource = "ics" | "google-shared" | "google-own" | "none";

export interface FeedResult {
  events: CalendarEvent[];
  source: FeedSource;
  /** null when the feed loaded cleanly */
  warning: string | null;
}

interface Window {
  fromIso: string;
  toIso: string;
}

const EMPTY: FeedResult = { events: [], source: "none", warning: null };

async function fromIcs(url: string, who: string, { fromIso, toIso }: Window): Promise<FeedResult> {
  try {
    const events = await icsEventsBetween({ url, from: new Date(fromIso), to: new Date(toIso) });
    return { events, source: "ics", warning: null };
  } catch (err) {
    const status = err instanceof IcsFetchError ? err.status : 0;
    return {
      events: [],
      source: "ics",
      warning: `${who} calendar link didn't work. ${explainFeedFailure(url, status)}`,
    };
  }
}

async function fromSharedGoogle(
  calendarId: string,
  who: string,
  { fromIso, toIso }: Window,
): Promise<FeedResult> {
  if (!isGoogleConnected()) {
    return {
      events: [],
      source: "google-shared",
      warning: `${who} calendar is set to “shared with you”, but your own Google account isn't connected — connect it in Settings → Google.`,
    };
  }
  try {
    const events = await listEventsRange(fromIso, toIso, calendarId);
    return { events, source: "google-shared", warning: null };
  } catch (err) {
    const status = err instanceof GoogleCalendarError ? err.status : 0;
    const warning =
      status === 404
        ? `Google doesn't see a calendar at ${calendarId} for your account — check the address, and that she shared it with you.`
        : status === 403
          ? `Your Google account isn't allowed to read ${calendarId} yet — she needs to share her calendar with you (“See all event details”).`
          : `Couldn't read ${calendarId} from Google${status ? ` (HTTP ${status})` : ""}.`;
    return { events: [], source: "google-shared", warning };
  }
}

/** The owner's own calendar: pasted feed if there is one, else their Google. */
export async function ownerEvents(joint: JointSettings, window: Window): Promise<FeedResult> {
  const who = joint.ownerName ? `${joint.ownerName}'s` : "Your";
  if (joint.ownerIcsUrl) return fromIcs(joint.ownerIcsUrl, who, window);
  if (!isGoogleConnected()) return EMPTY;
  try {
    const events = await listEventsRange(window.fromIso, window.toIso);
    return { events, source: "google-own", warning: null };
  } catch {
    return { events: [], source: "google-own", warning: "Google Calendar is unreachable right now." };
  }
}

/** The partner's calendar: pasted feed, else a calendar shared with the owner. */
export async function partnerEvents(joint: JointSettings, window: Window): Promise<FeedResult> {
  const who = joint.partnerName ? `${joint.partnerName}'s` : "Their";
  if (joint.partnerIcsUrl) return fromIcs(joint.partnerIcsUrl, who, window);
  if (joint.partnerGoogleId) return fromSharedGoogle(joint.partnerGoogleId, who, window);
  return EMPTY;
}
