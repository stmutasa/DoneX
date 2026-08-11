/**
 * Recent sent-mail digest, fed to inbox triage as context: what the user has
 * already replied to or committed to. Best-effort — any failure yields "".
 */
import "server-only";
import { googleFetch, isGoogleConnected } from "@/lib/google/oauth";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const QUERY = "in:sent newer_than:1d";
const MAX_RESULTS = 8;
const CACHE_TTL_MS = 10 * 60_000;

interface GmailMessage {
  snippet?: string;
  payload?: { headers?: { name?: string; value?: string }[] };
}

function header(message: GmailMessage, name: string): string {
  const match = message.payload?.headers?.find(
    (h) => (h.name ?? "").toLowerCase() === name.toLowerCase(),
  );
  return (match?.value ?? "").trim();
}

let cache: { at: number; digest: string } | null = null;

export async function recentSentDigest(): Promise<string> {
  if (!isGoogleConnected()) return "";
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.digest;

  try {
    const params = new URLSearchParams({ q: QUERY, maxResults: String(MAX_RESULTS) });
    const listRes = await googleFetch(`${GMAIL_BASE}/messages?${params.toString()}`);
    if (!listRes.ok) return "";
    const list = (await listRes.json()) as { messages?: { id?: string }[] };
    const ids = (list.messages ?? [])
      .map((m) => m.id)
      .filter((id): id is string => !!id)
      .slice(0, MAX_RESULTS);

    const lines: string[] = [];
    for (const id of ids) {
      const res = await googleFetch(
        `${GMAIL_BASE}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=To&metadataHeaders=Subject`,
      );
      if (!res.ok) continue;
      const message = (await res.json()) as GmailMessage;
      const to = header(message, "To").replace(/<[^>]+>/g, "").trim() || "someone";
      const subject = header(message, "Subject") || "(no subject)";
      const snippet = (message.snippet ?? "").trim();
      lines.push(`→ To ${to} · "${subject}"${snippet ? ` — ${snippet}` : ""}`.slice(0, 180));
    }

    cache = { at: Date.now(), digest: lines.join("\n") };
    return cache.digest;
  } catch {
    return "";
  }
}
