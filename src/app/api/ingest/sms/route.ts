/**
 * SMS ingest webhook (token-gated, no session) — e.g. MacroDroid forwarding
 * incoming texts. Accepts JSON, and raw text/plain as a fallback.
 */
import crypto from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { inboxRepo, settingsRepo } from "@/lib/db/repos";
import { aiConfigured, triageInboxItem } from "@/lib/ai";
import { parseIngestPayload } from "@/lib/ingest";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  from: z.string().min(1),
  body: z.string().min(1),
  receivedAt: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const settings = settingsRepo.getApp();
  const expected = settings.ingestToken;
  const provided = request.headers.get("x-donex-token") ?? "";
  if (!expected || !tokenMatches(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Checked after the token so an unauthorized caller learns nothing about
  // whether capture exists here.
  if (!settings.smsCaptureEnabled) {
    return NextResponse.json({ error: "SMS capture is turned off" }, { status: 403 });
  }

  const raw = (await request.text()).trim();
  const search = new URL(request.url).searchParams;
  if (!raw && !search.get("body")) {
    return NextResponse.json({ error: "Empty body" }, { status: 400 });
  }

  const payload = parseIngestPayload(raw, request.headers.get("content-type") ?? "", search);
  const parsed = BodySchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json({ error: "Expected {from, body}" }, { status: 400 });
  }

  const { from, body, receivedAt } = parsed.data;
  const received = parseDate(receivedAt);
  const minuteKey = new Date(Math.floor(received.getTime() / 60_000) * 60_000).toISOString();
  const externalId = `sms:${sha1(`${from}|${body}|${minuteKey}`)}`;

  const item = inboxRepo.create({
    source: "sms",
    externalId,
    fromLabel: from.slice(0, 120),
    content: body.slice(0, 1000),
    receivedAt: received.toISOString(),
  });
  if (!item) return NextResponse.json({ ok: true, deduped: true });

  if (aiConfigured()) {
    try {
      await triageInboxItem(item.id);
    } catch {
      // triage is best-effort — the item is already captured
    }
  }

  return NextResponse.json({ ok: true, id: item.id });
}

function parseDate(value: string | undefined): Date {
  if (!value) return new Date();
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : new Date();
}

function sha1(value: string): string {
  return crypto.createHash("sha1").update(value).digest("hex");
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
