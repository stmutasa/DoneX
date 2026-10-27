/**
 * Payload extraction for the SMS ingest webhook.
 *
 * Phone automation apps (MacroDroid, Tasker) build request bodies by plain
 * string interpolation, so a text containing a quote or a newline yields
 * invalid JSON. Accepting query params and form encoding too — and salvaging
 * the documented JSON template when it arrives malformed — means the message
 * survives whatever shape the phone manages to send.
 */

export interface IngestPayload {
  from?: string;
  body?: string;
  receivedAt?: string;
}

/** The {"from":…,"body":…} template our setup docs use, tolerant of raw
 *  newlines and unescaped quotes inside the message. */
const TEMPLATE_RE =
  /^\s*\{\s*"from"\s*:\s*"([\s\S]*?)"\s*,\s*"body"\s*:\s*"([\s\S]*)"\s*\}\s*$/;

/** Where a JSON payload may carry the message, in order of preference. */
const MESSAGE_KEYS = ["body", "message", "text"] as const;

function clean(value: string | null | undefined): string | undefined {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : undefined;
}

export function parseIngestPayload(
  raw: string,
  contentType: string,
  search: URLSearchParams,
): IngestPayload {
  // Query params first: the phone URL-encodes them, so punctuation in the
  // message can never break them.
  const queryBody = clean(search.get("body"));
  if (queryBody) {
    return {
      from: clean(search.get("from")) ?? "SMS",
      body: queryBody,
      receivedAt: clean(search.get("receivedAt")),
    };
  }

  const text = raw.trim();
  if (!text) return {};

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(text);
    const formBody = clean(form.get("body"));
    if (formBody) {
      return {
        from: clean(form.get("from")) ?? "SMS",
        body: formBody,
        receivedAt: clean(form.get("receivedAt")),
      };
    }
    // The form has a message field, but it is empty.
    if (form.has("body")) return {};
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      const str = (v: unknown) => clean(typeof v === "string" ? v : undefined);
      // Our template says "body"; other phone apps' say "message" or "text".
      const key = MESSAGE_KEYS.find((k) => k in rec);
      if (key) {
        const body = str(rec[key]);
        // An empty message (a picture text, say) has nothing to capture; it
        // must not become an item whose text is the raw JSON.
        if (!body) return {};
        return {
          from: str(rec.from) ?? str(rec.sender) ?? "SMS",
          body,
          receivedAt: str(rec.receivedAt),
        };
      }
    }
  } catch {
    // Not valid JSON — most likely a quote or newline in the message text.
    const salvaged = TEMPLATE_RE.exec(text);
    if (salvaged) {
      const body = clean(salvaged[2]);
      return body ? { from: clean(salvaged[1]) ?? "SMS", body } : {};
    }
  }

  // Anything else: treat the whole payload as the message.
  return { from: "SMS", body: text };
}
