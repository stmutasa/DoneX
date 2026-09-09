/**
 * Notes for a task the AI lifted out of the inbox.
 *
 * A title like "Renew the parking permit" loses the thing that made it
 * actionable — who asked, by when, for how much, which reference number. The
 * task carries a short summary of what the message actually wanted, plus a
 * line saying where it came from, so it still makes sense next Tuesday.
 * Pure and client-safe.
 */

const MAX_SUMMARY = 400;
const MAX_EXCERPT = 300;

export interface InboxNoteSource {
  /** the AI's summary of the sender's intent; empty when it gave none */
  summary?: string | null;
  /** the raw captured text, used only when there is no summary */
  content: string;
  /** sender, e.g. "DMV <noreply@dmv.gov>" */
  fromLabel: string;
  source: string;
  receivedAt: string;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function excerpt(content: string): string {
  const flat = collapse(content);
  if (flat.length <= MAX_EXCERPT) return flat;
  // Prefer a sentence boundary over a hard cut.
  const cut = flat.slice(0, MAX_EXCERPT);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return `${(stop >= MAX_EXCERPT / 2 ? cut.slice(0, stop + 1) : cut).trim()}…`;
}

function whenLabel(receivedAt: string): string {
  const ms = Date.parse(receivedAt);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function sourceLabel(source: string): string {
  if (source === "gmail") return "email";
  if (source === "sms") return "text";
  return source || "capture";
}

/** The notes body for a task created from an inbox item. */
export function composeInboxNotes(input: InboxNoteSource): string {
  const summary = collapse(input.summary ?? "").slice(0, MAX_SUMMARY);
  const body = summary || excerpt(input.content);

  const who = collapse(input.fromLabel).slice(0, 120);
  const when = whenLabel(input.receivedAt);
  const parts = [`From ${who || "an unknown sender"}`, sourceLabel(input.source), when].filter(
    Boolean,
  );
  const provenance = parts.join(" · ");

  return body ? `${body}\n\n${provenance}` : provenance;
}
