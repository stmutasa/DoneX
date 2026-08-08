/**
 * SMS ingest webhook (token-gated, no session) — e.g. MacroDroid forwarding
 * incoming texts. Accepts JSON, and raw text/plain as a fallback.
 */
import crypto from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { inboxRepo, settingsRepo } from "@/lib/db/repos";
import { aiConfigured, triageInboxItem } from "@/lib/ai";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  from: z.string().min(1),
  body: z.string().min(1),
  receivedAt: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const expected = settingsRepo.getApp().ingestToken;
  const provided = request.headers.get("x-donex-token") ?? "";
  if (!expected || !tokenMatches(provided, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const raw = (await request.text()).trim();
  if (!raw) return NextResponse.json({ error: "Empty body" }, { status: 400 });

  const parsed = BodySchema.safeParse(asPayload(raw));
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

/** JSON when parseable, else the raw text treated as the message body. */
function asPayload(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through to plain text
  }
  return { from: "SMS", body: raw };
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
