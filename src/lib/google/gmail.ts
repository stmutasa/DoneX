/**
 * Gmail scan (REST v1): recent unread primary-inbox mail → inbox items,
 * auto-triaged when the AI engine is configured.
 */
import "server-only";
import { googleApiError, googleFetch, isGoogleConnected, GOOGLE_NOT_CONNECTED } from "@/lib/google/oauth";
import { inboxRepo } from "@/lib/db/repos";
import { aiConfigured, triageInboxItem } from "@/lib/ai";
import { nowIso } from "@/lib/utils";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const QUERY = "in:inbox category:primary is:unread newer_than:2d";
const MAX_RESULTS = 15;

interface GmailListResponse {
  messages?: { id?: string }[];
}

interface GmailMessage {
  id?: string;
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: { name?: string; value?: string }[] };
}

function headerValue(message: GmailMessage, name: string): string {
  const match = message.payload?.headers?.find(
    (h) => (h.name ?? "").toLowerCase() === name.toLowerCase()
  );
  return (match?.value ?? "").trim();
}

/** "Jane Doe <jane@x.com>" → "Jane Doe"; "<jane@x.com>" → "jane@x.com" */
function cleanFromLabel(raw: string): string {
  const value = raw.trim();
  if (!value) return "Gmail";
  const match = value.match(/^(.*?)\s*<([^>]+)>\s*$/);
  const name = match ? match[1] : value;
  const stripped = name.replace(/^["']+|["']+$/g, "").trim();
  const fallback = match ? match[2].trim() : value;
  return (stripped || fallback).slice(0, 120);
}

function receivedAtFrom(message: GmailMessage): string {
  const ms = Number(message.internalDate);
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : nowIso();
}

/** Ingests new messages into the inbox. Returns how many items were created. */
export async function scanGmail(): Promise<number> {
  if (!isGoogleConnected()) throw new Error(GOOGLE_NOT_CONNECTED);

  const listParams = new URLSearchParams({ q: QUERY, maxResults: String(MAX_RESULTS) });
  const listRes = await googleFetch(`${GMAIL_BASE}/messages?${listParams.toString()}`);
  if (!listRes.ok) throw await googleApiError(listRes, "Gmail scan");

  const list = (await listRes.json()) as GmailListResponse;
  const ids = (list.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);
  if (ids.length === 0) return 0;

  const known = new Set(
    inboxRepo
      .list({ status: "all" })
      .map((item) => item.externalId)
      .filter((id): id is string => !!id)
  );

  const createdIds: string[] = [];
  for (const id of ids) {
    const externalId = `gmail:${id}`;
    if (known.has(externalId)) continue;

    const detailUrl = `${GMAIL_BASE}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`;
    const res = await googleFetch(detailUrl);
    if (!res.ok) continue;

    const message = (await res.json()) as GmailMessage;
    const subject = headerValue(message, "Subject") || "(no subject)";
    const snippet = (message.snippet ?? "").trim();
    const content = `${subject}${snippet ? ` — ${snippet}` : ""}`.trim().slice(0, 500);

    const item = inboxRepo.create({
      source: "gmail",
      externalId,
      fromLabel: cleanFromLabel(headerValue(message, "From")),
      content,
      receivedAt: receivedAtFrom(message),
    });
    if (item) createdIds.push(item.id);
  }

  if (createdIds.length > 0 && aiConfigured()) {
    for (const itemId of createdIds) {
      try {
        await triageInboxItem(itemId);
      } catch {
        // triage is best-effort — the item stays in the inbox untriaged
      }
    }
  }

  return createdIds.length;
}
