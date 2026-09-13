/**
 * Token accounting: turning recorded AI calls into the numbers the Usage
 * screen shows. Aggregation happens here rather than in SQL so the same
 * grouping serves every window and is testable without a database.
 * Client-safe.
 */

export interface UsageRow {
  /** local date key, YYYY-MM-DD */
  dateLocal: string;
  /** "openai" | "anthropic" | "custom" */
  provider: string;
  model: string;
  /** what the tokens were spent on: triage, briefing, chat… */
  feature: string;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageTotals {
  calls: number;
  input: number;
  output: number;
  total: number;
}

export interface UsageBucket extends UsageTotals {
  key: string;
  label: string;
  /** fraction of the window's tokens, 0–1 */
  share: number;
}

export interface UsageRollup extends UsageTotals {
  byCompany: UsageBucket[];
  byModel: UsageBucket[];
  byFeature: UsageBucket[];
  /** oldest first, one entry per day in the window (gaps filled with zero) */
  daily: { dateLocal: string; total: number }[];
}

const EMPTY: UsageTotals = { calls: 0, input: 0, output: 0, total: 0 };

/** The company behind a provider id, for the "by company" breakdown. */
export function companyOf(provider: string): { key: string; label: string } {
  if (provider === "openai") return { key: "openai", label: "OpenAI" };
  if (provider === "anthropic") return { key: "anthropic", label: "Anthropic" };
  return { key: "custom", label: "Custom endpoint" };
}

const FEATURE_LABELS: Record<string, string> = {
  triage: "Inbox triage",
  briefing: "Morning briefing",
  review: "Weekly review",
  breakdown: "Paste → tasks",
  chat: "Assistant chat",
  test: "Connection tests",
  other: "Other",
};

export function featureLabel(feature: string): string {
  return FEATURE_LABELS[feature] ?? "Other";
}

/** 812 · 43.1k · 1.24M — compact enough for a phone, still honest. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

function add(into: UsageTotals, row: UsageRow): void {
  into.calls += 1;
  into.input += row.inputTokens;
  into.output += row.outputTokens;
  into.total += row.inputTokens + row.outputTokens;
}

function bucketsFrom(
  rows: UsageRow[],
  keyOf: (row: UsageRow) => { key: string; label: string },
  grandTotal: number,
): UsageBucket[] {
  const map = new Map<string, UsageBucket>();
  for (const row of rows) {
    const { key, label } = keyOf(row);
    const bucket = map.get(key) ?? { key, label, ...EMPTY, share: 0 };
    add(bucket, row);
    map.set(key, bucket);
  }
  return [...map.values()]
    .map((b) => ({ ...b, share: grandTotal > 0 ? b.total / grandTotal : 0 }))
    .sort((a, b) => b.total - a.total);
}

/** Every day in [from, to] inclusive, as local date keys. */
export function dateKeysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = new Date(`${to}T00:00:00`);
  const cursor = new Date(`${from}T00:00:00`);
  while (cursor <= end && out.length < 800) {
    out.push(
      `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`,
    );
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

export function totalsOf(rows: UsageRow[]): UsageTotals {
  const totals = { ...EMPTY };
  for (const row of rows) add(totals, row);
  return totals;
}

/**
 * Group a window's calls three ways, plus a per-day series for the chart.
 * `from`/`to` bound the series so quiet days still show as zero.
 */
export function rollupUsage(rows: UsageRow[], from?: string, to?: string): UsageRollup {
  const totals = totalsOf(rows);

  const perDay = new Map<string, number>();
  for (const row of rows) {
    perDay.set(row.dateLocal, (perDay.get(row.dateLocal) ?? 0) + row.inputTokens + row.outputTokens);
  }
  const days =
    from && to
      ? dateKeysBetween(from, to)
      : [...perDay.keys()].sort((a, b) => a.localeCompare(b));

  return {
    ...totals,
    byCompany: bucketsFrom(rows, (r) => companyOf(r.provider), totals.total),
    byModel: bucketsFrom(rows, (r) => ({ key: r.model, label: r.model || "(unknown)" }), totals.total),
    byFeature: bucketsFrom(rows, (r) => ({ key: r.feature, label: featureLabel(r.feature) }), totals.total),
    daily: days.map((dateLocal) => ({ dateLocal, total: perDay.get(dateLocal) ?? 0 })),
  };
}
