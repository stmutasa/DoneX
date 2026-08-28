/**
 * Web push. VAPID keys are generated on demand and persisted in settings, so
 * there is nothing to configure — subscriptions that 404/410 are pruned.
 */
import "server-only";
import webpush, { type PushSubscription } from "web-push";
import { pushRepo, settingsRepo } from "@/lib/db/repos";

const VAPID_SUBJECT = "mailto:donex@local";

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** Returns the stored VAPID pair, generating + persisting one on first use. */
export function ensureVapid(): VapidKeys {
  const stored = settingsRepo.getApp().vapid;
  if (stored?.publicKey && stored.privateKey) return stored;
  const generated = webpush.generateVAPIDKeys();
  const keys: VapidKeys = {
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
  };
  settingsRepo.updateApp({ vapid: keys });
  return keys;
}

export function hasPushSubscriptions(): boolean {
  return pushRepo.list().length > 0;
}

function toSubscription(raw: Record<string, unknown>): PushSubscription | null {
  const endpoint = typeof raw.endpoint === "string" ? raw.endpoint : "";
  const keys = raw.keys as { p256dh?: unknown; auth?: unknown } | undefined;
  if (!endpoint || typeof keys?.p256dh !== "string" || typeof keys.auth !== "string") {
    return null;
  }
  return { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/** Fan-out to stored subscriptions (optionally one role's). Never throws. */
export async function sendPushToAll(
  payload: PushPayload,
  roles?: ("owner" | "partner")[]
): Promise<number> {
  try {
    const rows = pushRepo.list(roles);
    if (rows.length === 0) return 0;

    const { publicKey, privateKey } = ensureVapid();
    webpush.setVapidDetails(VAPID_SUBJECT, publicKey, privateKey);
    const json = JSON.stringify(payload);

    let sent = 0;
    await Promise.all(
      rows.map(async (row) => {
        const subscription = toSubscription(row.subscription);
        if (!subscription) {
          pushRepo.remove(row.endpoint);
          return;
        }
        try {
          await webpush.sendNotification(subscription, json);
          sent++;
        } catch (err) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410) {
            pushRepo.remove(row.endpoint);
          } else {
            console.error("[push] delivery failed", statusCode ?? "", err);
          }
        }
      })
    );
    return sent;
  } catch (err) {
    console.error("[push] send failed", err);
    return 0;
  }
}
