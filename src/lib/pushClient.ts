/**
 * This device's web-push subscription, from the browser's side.
 *
 * The server keeps one row per endpoint, tagged with the role and session
 * that last posted it, and drops it when that session ends. So the app
 * re-posts the subscription on every load (`syncPush`): the row follows
 * whoever is signed in on the device, and a row the server pruned comes back.
 */
import { useCallback, useEffect, useState } from "react";
import { pushApi } from "@/lib/api";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

/** False when the subscription was made for a VAPID key the server no longer
 *  uses (a reset database); pushes to it can never arrive. */
function madeForKey(sub: PushSubscription, publicKey: string): boolean {
  const key = sub.options?.applicationServerKey;
  if (!key) return true; // the browser doesn't say; assume it's fine
  const have = new Uint8Array(key);
  const want = urlBase64ToUint8Array(publicKey);
  return have.length === want.length && have.every((b, i) => b === want[i]);
}

let synced: Promise<boolean> | null = null;

/**
 * Re-posts this device's subscription under the current session, once per
 * page load. Resolves whether the device is subscribed. A subscription for an
 * old VAPID key is dropped, so the UI offers to turn notifications on again.
 */
export function syncPush(): Promise<boolean> {
  synced ??= (async () => {
    if (!pushSupported() || Notification.permission !== "granted") return false;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return false;
    try {
      const { publicKey } = await pushApi.vapid();
      if (!madeForKey(sub, publicKey)) {
        await sub.unsubscribe().catch(() => false);
        return false;
      }
      await pushApi.subscribe(sub.toJSON());
    } catch {
      synced = null; // offline or similar: try again next time
    }
    return true;
  })();
  return synced;
}

/** Asks for permission and signs this device up afresh. Throws with a message for the person. */
export async function enablePush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifications are blocked for this site.");
  const reg = await getRegistration();
  if (!reg) throw new Error("Service worker unavailable — try after a reload.");
  const { publicKey } = await pushApi.vapid();
  // Start over rather than reuse: an old subscription may be for a key the
  // server no longer has, or an endpoint the push service has dropped.
  const existing = await reg.pushManager.getSubscription();
  if (existing) await existing.unsubscribe().catch(() => false);
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  await pushApi.subscribe(sub.toJSON());
  synced = Promise.resolve(true);
}

/** Unsubscribes this device in the browser, for sign-out. The server has
 *  already dropped its row by then. Never throws. */
export async function forgetPushOnThisDevice(): Promise<void> {
  synced = null;
  try {
    if (!pushSupported()) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    /* nothing more to do: the push service drops it once it stops answering */
  }
}

/**
 * This device's push state for a signed-in screen. `active` waits until the
 * session's role is known, so the re-post lands under the right person.
 */
export function usePushDevice(active: boolean) {
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [working, setWorking] = useState(false);

  // `supported` turns true only once the sync has answered, so an offer to
  // turn notifications on doesn't flash up on a device that already has them.
  useEffect(() => {
    if (!active || !pushSupported()) return;
    let alive = true;
    void syncPush().then((on) => {
      if (!alive) return;
      setSubscribed(on);
      setSupported(true);
    });
    return () => {
      alive = false;
    };
  }, [active]);

  const enable = useCallback(async () => {
    setWorking(true);
    try {
      await enablePush();
      setSubscribed(true);
    } finally {
      setWorking(false);
    }
  }, []);

  return { supported, subscribed, setSubscribed, working, enable };
}
