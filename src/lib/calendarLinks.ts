/**
 * Understanding the calendar links people actually paste.
 *
 * Google hands out several URLs that look interchangeable and are not: the
 * "public address" only resolves for a calendar shared with the world, the
 * embed/cid links are web pages rather than feeds, and only the "secret
 * address in iCal format" works for a private calendar. Classifying the paste
 * lets Settings say what's wrong at the moment of pasting, instead of leaving
 * a saved-but-doomed URL to fail later as "feed unreachable". Client-safe.
 */

export type CalendarLinkKind =
  | "google-secret" // …/ical/<id>/private-<token>/basic.ics — private, works
  | "google-public" // …/ical/<id>/public/basic.ics — only if world-readable
  | "google-view" // /calendar/embed?… or ?cid=… — a page, not a feed
  | "webcal" // webcal://… (iCloud and friends)
  | "ics" // any other https URL that looks like a feed
  | "empty"
  | "unknown";

export interface CalendarLinkVerdict {
  kind: CalendarLinkKind;
  /** null when the link is usable as a feed */
  problem: string | null;
}

const GOOGLE_HOST = /^https?:\/\/calendar\.google\.com\//i;

export function classifyCalendarLink(raw: string): CalendarLinkVerdict {
  const url = raw.trim();
  if (!url) return { kind: "empty", problem: null };

  if (GOOGLE_HOST.test(url)) {
    if (/\/calendar\/ical\/.+\/private-[^/]+\/basic\.ics/i.test(url)) {
      return { kind: "google-secret", problem: null };
    }
    if (/\/calendar\/ical\/.+\/public\/basic\.ics/i.test(url)) {
      return {
        kind: "google-public",
        problem:
          "That's the calendar's public address — it only works if the calendar is shared with the whole world. Use the “Secret address in iCal format” from the same Settings page instead.",
      };
    }
    if (/\/calendar\/(embed|u\/\d+)|[?&]cid=/i.test(url)) {
      return {
        kind: "google-view",
        problem:
          "That's a link for viewing the calendar in a browser, not a feed DoneX can read. Use the “Secret address in iCal format”, or have her share the calendar with your Google account instead.",
      };
    }
    return {
      kind: "unknown",
      problem:
        "That doesn't look like a calendar feed. In Google Calendar → Settings → her calendar → Integrate calendar, copy the “Secret address in iCal format”.",
    };
  }

  if (/^webcal:\/\//i.test(url)) return { kind: "webcal", problem: null };

  if (/^https?:\/\//i.test(url)) {
    if (/\.ics(\?|$)|\/ical|format=ical/i.test(url)) return { kind: "ics", problem: null };
    return {
      kind: "unknown",
      problem: "That link doesn't look like a calendar feed (it should end in .ics).",
    };
  }

  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(url)) {
    return {
      kind: "unknown",
      problem:
        "That's an email address, not a feed link. To use an address, pick “Shared with you” above instead.",
    };
  }

  return {
    kind: "unknown",
    problem: "Paste a calendar link starting with https:// or webcal://.",
  };
}

/** Plain-English reading of a failed feed fetch, for the Test button. */
export function explainFeedFailure(url: string, status: number): string {
  const kind = classifyCalendarLink(url).kind;
  if (status === 404 && kind === "google-public") {
    return "Google answered “not found” — her calendar isn't public, which is why this link can't work. Use the secret address, or the “Shared with you” option.";
  }
  if (status === 404) return "The calendar host answered “not found” — check the link was copied whole.";
  if (status === 401 || status === 403) {
    return "The calendar host refused the request — this link needs a sign-in, so it isn't a feed DoneX can read.";
  }
  if (status === 0) return "Couldn't reach the calendar host at all — check the link and try again.";
  return `The calendar host answered HTTP ${status}.`;
}
