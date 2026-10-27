import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { aiConfigured, generateWeeklyReview } from "@/lib/ai";
import { completionsRepo, reviewsRepo, settingsRepo } from "@/lib/db/repos";
import { reviewIsStale, weekRange } from "@/lib/reviewWeek";
import { isoWeekKey, localDateKey } from "@/lib/utils";
import type { WeeklyReview } from "@/lib/types";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  refresh: z.string().optional(),
  // The weekly push links to the week it was about; anything unreadable
  // falls back to this week.
  week: z
    .string()
    .regex(/^\d{4}-W\d{2}$/)
    .optional()
    .catch(undefined),
});

/** The day a week's review was last rewritten without being asked, so it is tried once a day at most. */
const kvAutoRefresh = (weekKey: string) => `review.autoRefresh.${weekKey}`;
/** The day writing a week's first review last failed: no automatic retry until tomorrow. */
const kvAutoFail = (weekKey: string) => `review.autoFail.${weekKey}`;

/** One generation per week at a time: a reload or a refocus mid-call shares it. */
const inFlight = new Map<string, Promise<WeeklyReview>>();

function generateOnce(weekKey: string, force: boolean): Promise<WeeklyReview> {
  const running = inFlight.get(weekKey);
  if (running) return running;
  const job = generateWeeklyReview(weekKey, { force }).finally(() => inFlight.delete(weekKey));
  inFlight.set(weekKey, job);
  return job;
}

export async function GET(req: Request): Promise<Response> {
  const gate = await requireOwner();
  if (gate) return gate;
  if (!aiConfigured()) return NextResponse.json({ error: "AI not configured" }, { status: 409 });

  const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid query" }, { status: 400 });

  const tz = settingsRepo.getApp().tz;
  const now = new Date();
  const todayKey = localDateKey(now, tz);
  const thisWeek = isoWeekKey(now, tz);
  // A week still to come has nothing to review yet.
  const asked = parsed.data.week;
  const weekKey = asked && asked <= thisWeek ? asked : thisWeek;

  const refresh = parsed.data.refresh === "1";
  const cached = reviewsRepo.get(weekKey);

  // A saved review is rewritten unasked only when it has fallen behind (see
  // reviewIsStale), and at most once a day per week, success or not: every
  // rewrite is a paid model call, and the page refetches on every focus.
  let force = refresh;
  if (!refresh && cached) {
    const range = weekRange(weekKey);
    const stale =
      !!range &&
      settingsRepo.getKV(kvAutoRefresh(weekKey)) !== todayKey &&
      reviewIsStale({
        generatedAt: cached.generatedAt,
        completedCount: cached.completedCount,
        weekKey,
        todayKey,
        tz,
        completedNow: () => completionsRepo.countRange(range.from, range.to),
      });
    if (!stale) return NextResponse.json({ review: cached });
    force = true;
  }
  // Written before the call, so a failure (or the refetch after a failed
  // Regenerate) doesn't set off another one today.
  if (force) settingsRepo.setKV(kvAutoRefresh(weekKey), todayKey);

  // No review yet and writing one already failed today: don't pay to fail
  // again on every visit and refocus. Regenerate always tries.
  if (!refresh && !cached && settingsRepo.getKV(kvAutoFail(weekKey)) === todayKey) {
    return NextResponse.json({ error: "Could not write the review just now" }, { status: 502 });
  }

  try {
    const review = await generateOnce(weekKey, force);
    return NextResponse.json({ review });
  } catch (err) {
    // A rewrite nobody asked for that fails still leaves the saved one to show.
    if (cached && !refresh) return NextResponse.json({ review: cached });
    // With nothing saved, the next automatic try waits for tomorrow; this is
    // noted after a failed Regenerate too, for the refetch that follows it.
    if (!cached) settingsRepo.setKV(kvAutoFail(weekKey), todayKey);
    const message = err instanceof Error ? err.message : "Could not generate the review";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
