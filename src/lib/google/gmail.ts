/**
 * Gmail scan (REST v1): recent unread primary-inbox mail → inbox items,
 * auto-triaged when the AI engine is configured.
 */
import "server-only";
import { googleApiError, googleFetch, isGoogleConnected, GOOGLE_NOT_CONNECTED } from "@/lib/google/oauth";
import { inboxRepo, settingsRepo } from "@/lib/db/repos";
import { aiConfigured, triageInboxItem } from "@/lib/ai";
import { mapLimit, nowIso } from "@/lib/utils";
import { DEFAULT_GMAIL_QUERY } from "@/lib/google/queries";
import type { GmailScanState } from "@/lib/types";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_RESULTS = 25;

function gmailQuery(): string {
  return settingsRepo.getApp().google.gmailQuery.trim() || DEFAULT_GMAIL_QUERY;
}

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

const SCAN_STATE_KEY = "gmail.lastScan";

const EMPTY_SCAN: GmailScanState = {
  at: null,
  matched: 0,
  created: 0,
  query: "",
  error: null,
};

export function lastScanState(): GmailScanState {
  const raw = settingsRepo.getKV(SCAN_STATE_KEY);
  if (!raw) return EMPTY_SCAN;
  try {
    return { ...EMPTY_SCAN, ...(JSON.parse(raw) as Partial<GmailScanState>) };
  } catch {
    return EMPTY_SCAN;
  }
}

function recordScan(state: GmailScanState): void {
  settingsRepo.setKV(SCAN_STATE_KEY, JSON.stringify(state));
}

/**
 * Ingests new messages into the inbox. Returns how many items were created.
 * The outcome is recorded either way — hourly scheduler scans fail with nobody
 * watching, and an empty inbox otherwise looks identical to a broken one.
 */
export async function scanGmail(): Promise<number> {
  if (!isGoogleConnected()) throw new Error(GOOGLE_NOT_CONNECTED);
  const query = gmailQuery();
  try {
    const { matched, created } = await runScan(query);
    recordScan({ at: nowIso(), matched, created, query, error: null });
    return created;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Gmail scan failed";
    recordScan({ at: nowIso(), matched: 0, created: 0, query, error: message });
    throw err;
  }
}

async function runScan(query: string): Promise<{ matched: number; created: number }> {
  const listParams = new URLSearchParams({ q: query, maxResults: String(MAX_RESULTS) });
  const listRes = await googleFetch(`${GMAIL_BASE}/messages?${listParams.toString()}`);
  if (!listRes.ok) throw await googleApiError(listRes, "Gmail scan");

  const list = (await listRes.json()) as GmailListResponse;
  const ids = (list.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);
  if (ids.length === 0) return { matched: 0, created: 0 };

  const known = new Set(
    inboxRepo
      .list({ status: "all" })
      .map((item) => item.externalId)
      .filter((id): id is string => !!id)
  );

  const fresh = ids.filter((id) => !known.has(`gmail:${id}`));

  // Fetch message metadata concurrently — serial fetches plus serial AI triage
  // was slow enough to trip client request timeouts on a first-ever scan.
  const settled = await mapLimit(fresh, 5, async (id) => {
    const detailUrl = `${GMAIL_BASE}/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`;
    const res = await googleFetch(detailUrl);
    if (!res.ok) return null;

    const message = (await res.json()) as GmailMessage;
    const subject = headerValue(message, "Subject") || "(no subject)";
    const snippet = (message.snippet ?? "").trim();
    const content = `${subject}${snippet ? ` — ${snippet}` : ""}`.trim().slice(0, 500);

    const item = inboxRepo.create({
      source: "gmail",
      externalId: `gmail:${id}`,
      fromLabel: cleanFromLabel(headerValue(message, "From")),
      content,
      receivedAt: receivedAtFrom(message),
    });
    return item?.id ?? null;
  });

  const createdIds = settled
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((id): id is string => !!id);

  if (createdIds.length > 0 && aiConfigured()) {
    // Best-effort, bounded concurrency; failures leave the item untriaged.
    await mapLimit(createdIds, 2, (itemId) => triageInboxItem(itemId));
  }

  return { matched: ids.length, created: createdIds.length };
}
