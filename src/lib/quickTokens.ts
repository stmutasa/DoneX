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
