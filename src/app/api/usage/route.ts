/**
 * Token usage for the Settings → Usage screen (owner only).
 *
 * Headline windows are always returned so the summary never depends on the
 * range you happen to be looking at; the breakdowns follow the chosen window.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { settingsRepo, usageRepo } from "@/lib/db/repos";
import { rollupUsage, totalsOf } from "@/lib/usage";
import { addDaysToDateKey, clamp, localDateKey } from "@/lib/utils";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const settings = settingsRepo.getApp();
  const todayKey = localDateKey(new Date(), settings.tz);
  const days = clamp(Number(req.nextUrl.searchParams.get("days")) || 7, 1, 365);
  const fromKey = addDaysToDateKey(todayKey, -(days - 1));

  // One read covers every window we report on, including the 30-day headline.
  const monthFrom = addDaysToDateKey(todayKey, -29);
  const earliest = fromKey < monthFrom ? fromKey : monthFrom;
  const rows = usageRepo.since(earliest);

  const lifetime = usageRepo.lifetime();
  const window = rows.filter((r) => r.dateLocal >= fromKey);

  return NextResponse.json({
    todayKey,
    days,
    from: fromKey,
    headline: {
      today: totalsOf(rows.filter((r) => r.dateLocal === todayKey)),
      week: totalsOf(rows.filter((r) => r.dateLocal >= addDaysToDateKey(todayKey, -6))),
      month: totalsOf(rows.filter((r) => r.dateLocal >= monthFrom)),
      all: { calls: lifetime.calls, input: lifetime.input, output: lifetime.output, total: lifetime.total },
    },
    since: lifetime.firstDay,
    rollup: rollupUsage(window, fromKey, todayKey),
    // What the tokens are being spent on right now, for context.
    active: {
      provider: settings.ai.provider,
      model:
        (settings.ai.provider === "custom" ? settings.ai.customModel : settings.ai.model) ||
        "auto-picked",
      fallbackProvider: settings.ai.fallbackProvider || null,
      fallbackModel: settings.ai.fallbackModel || null,
    },
  });
}

export async function DELETE() {
  const gate = await requireOwner();
  if (gate) return gate;
  usageRepo.clear();
  return NextResponse.json({ ok: true });
}
