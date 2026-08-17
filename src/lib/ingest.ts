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
  }

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const rec = parsed as Record<string, unknown>;
      const body = clean(typeof rec.body === "string" ? rec.body : undefined);
      if (body) {
        return {
          from: clean(typeof rec.from === "string" ? rec.from : undefined) ?? "SMS",
          body,
          receivedAt: clean(typeof rec.receivedAt === "string" ? rec.receivedAt : undefined),
        };
      }
    }
  } catch {
    // Not valid JSON — most likely a quote or newline in the message text.
    const salvaged = TEMPLATE_RE.exec(text);
    if (salvaged) {
      const body = clean(salvaged[2]);
      if (body) return { from: clean(salvaged[1]) ?? "SMS", body };
    }
  }

  // Anything else: treat the whole payload as the message.
  return { from: "SMS", body: text };
}
