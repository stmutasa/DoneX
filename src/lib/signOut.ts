/**
 * Signing out of this device, from every place that offers it.
 *
 * Queued offline changes are landed first, while the session can still
 * replay them (for a few seconds at most). The session cookie is httpOnly, so
 * only the server can end it: if the logout request fails this throws and
 * nothing else happens — the queue stays and so does the session — and the
 * caller says so instead of showing a lock screen over a live session. Once
 * the server has confirmed, the device forgets the rest (push subscription,
 * outbox, cached responses) and a full page load drops every in-memory cache,
 * SWR's included, before the next person unlocks.
 */
import { authApi } from "@/lib/api";
import { clearLocalDataOnSignOut, flushOutboxBeforeSignOut } from "@/lib/offline";
import { forgetPushOnThisDevice } from "@/lib/pushClient";

export async function signOutThisDevice(): Promise<void> {
  await flushOutboxBeforeSignOut();
  await authApi.logout();
  await forgetPushOnThisDevice();
  try {
    await clearLocalDataOnSignOut();
  } catch {
    /* the reload below still drops everything held in memory */
  }
  window.location.replace("/login");
}
