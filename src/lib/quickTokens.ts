/**
 * The quick-add token grammar, shared by the server parser (quickparse.ts)
 * and the preview chips in the quick-add sheet (format.ts), so what the sheet
 * shows is what gets saved. Client-safe: no Node or chrono imports.
 *
 * These are global regexes: use them with String.replace only, which resets
 * their position, never with test() or exec().
 */
import type { Priority } from "@/lib/types";

// A token only starts a word, so "bob@acme.com" and "site/page#setup" stay in
// the title, and names may use any script, combining marks included ("#café",
// "#किताब"); callers NFC-normalise the text first. A quoted project may use
// straight or curly quotes, since phones type “smart” ones. Group 1 is the
// leading whitespace, so replace it with a space to keep the words apart.
export const TAG_RE = /(^|\s)@([\p{L}\p{N}_][\p{L}\p{M}\p{N}_-]*)/gu;
export const PROJECT_RE = /(^|\s)#(?:["“]([^"“”]+)["”]|([\p{L}\p{N}_][\p{L}\p{M}\p{N}_-]*))/gu;
export const PRIORITY_RE = /(^|\s)!(p?[123]|high|med(?:ium)?|low)(?![\p{L}\p{N}_])/giu;

// Web addresses and email addresses are hidden before anything is read, so
// no tag, project or date is found inside one ("…/2026/10/26/story.html",
// "sat@domain.com"), then put back in the title as typed. Links are
// "http(s)://…", "www.…", or a bare "domain.tld/path".
const LINK_RE = new RegExp(
  [
    String.raw`\bhttps?:\/\/\S+`,
    String.raw`\bwww\.\S+`,
    String.raw`[\p{L}\p{M}\p{N}._%+-]+@[\p{L}\p{M}\p{N}-]+(?:\.[\p{L}\p{M}\p{N}-]+)+`,
    String.raw`[\p{L}\p{M}\p{N}-]+(?:\.[\p{L}\p{M}\p{N}-]+)*\.\p{L}{2,}\/\S*`,
  ].join("|"),
  "gu",
);
// A private-use character with no letters or digits in it. /api/tasks hides
// "#words" with others (U+E023, U+E100 up), so this one stays distinct.
const LINK_MASK = "\uE001";
const LINK_MASK_RUN = /\uE001+/g;

/**
 * `text` with each link swapped for a same-length run of placeholders, and
 * `unmask`, which puts the links back (in order) into any string made from it.
 */
export function maskLinks(text: string): { masked: string; unmask: (s: string) => string } {
  const links: string[] = [];
  const masked = text.replace(LINK_RE, (link) => {
    links.push(link);
    return LINK_MASK.repeat(link.length);
  });
  if (!links.length) return { masked, unmask: (s) => s };
  return {
    masked,
    unmask: (s) => {
      let i = 0;
      return s.replace(LINK_MASK_RUN, () => links[i++] ?? "");
    },
  };
}

/** Lower-cased priority token → priority. "1" / "p1" is the most urgent. */
export const PRIORITY_MAP: Record<string, Priority> = {
  p1: 3,
  p2: 2,
  p3: 1,
  "1": 3,
  "2": 2,
  "3": 1,
  high: 3,
  med: 2,
  medium: 2,
  low: 1,
};
