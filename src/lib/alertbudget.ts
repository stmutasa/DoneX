/**
 * Daily allowance for "go look at your inbox" alerts.
 *
 * Triage keeps running on its full cadence; this only limits how often it is
 * allowed to interrupt you. Anything over the allowance stays silent — the
 * items are still in the inbox, and the tab badge still counts them.
 */

export const MAX_INBOX_ALERTS_PER_DAY = 2;

export interface AlertBudget {
  /** may we send right now? */
  allowed: boolean;
  /** value to store after sending; null when nothing should be stored */
  next: string | null;
  used: number;
}

/** Stored as "YYYY-MM-DD@count"; a new local day resets the count. */
export function readAlertBudget(
  raw: string | null,
  dayKey: string,
  limit = MAX_INBOX_ALERTS_PER_DAY,
): AlertBudget {
  const [storedDay, rawCount] = (raw ?? "").split("@");
  const parsed = Number.parseInt(rawCount ?? "", 10);
  const used = storedDay === dayKey && Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  const allowed = used < limit;
  return { allowed, used, next: allowed ? `${dayKey}@${used + 1}` : null };
}
