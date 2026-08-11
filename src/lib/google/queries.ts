/**
 * Shared between the Gmail scanner and the settings UI, so it lives outside the
 * server-only module. Deliberately not restricted to category:primary — the
 * mail worth turning into a task (appointment confirmations, deliveries, bills)
 * is usually filed under Updates, and accounts with the category tabs switched
 * off match nothing at all for that operator.
 */
export const DEFAULT_GMAIL_QUERY = "in:inbox is:unread newer_than:7d";
