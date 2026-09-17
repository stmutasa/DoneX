/**
 * The read-only task feed: a secret link that answers "what do I still need
 * to do?" in Markdown, so another chat window — or anything else that can
 * fetch a URL — can read it without a session.
 *
 * Read-only and narrow on purpose. It carries open tasks and nothing else:
 * no settings, no keys, no calendar, no notes pages, and none of the shared
 * work the other person has taken on. A wrong or retired token is a plain
 * 404, so the link's existence isn't something you can probe for.
 */
import crypto from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { projectsRepo, settingsRepo, tasksRepo } from "@/lib/db/repos";
import { buildFeed, renderMarkdown } from "@/lib/shareFeed";

export const dynamic = "force-dynamic";

/** Shortest token we will ever mint; anything less is treated as unset. */
const MIN_TOKEN = 20;

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const settings = settingsRepo.getApp();
  const expected = settings.shareToken;

  if (!expected || expected.length < MIN_TOKEN || !tokenMatches(token, expected)) {
    return new NextResponse("Not found", { status: 404, headers: { "cache-control": "no-store" } });
  }

  const feed = buildFeed({
    tasks: tasksRepo.list({}),
    joint: tasksRepo.list({ space: "joint" }),
    projectNames: new Map(projectsRepo.list(true).map((p) => [p.id, p.name])),
    tz: settings.tz,
    now: new Date(),
    owner: settings.joint.ownerName,
  });

  const wantsJson = req.nextUrl.searchParams.get("format") === "json";
  const headers = {
    "cache-control": "no-store, max-age=0",
    // A secret URL is only secret while nothing indexes or caches it.
    "x-robots-tag": "noindex, nofollow, noarchive",
    "referrer-policy": "no-referrer",
  };

  if (wantsJson) return NextResponse.json(feed, { headers });
  return new NextResponse(renderMarkdown(feed), {
    headers: { ...headers, "content-type": "text/markdown; charset=utf-8" },
  });
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
