/**
 * Signing out of this device, from every place that offers it.
 *
 * Queued offline changes are landed first, while the session can still
 * replay them (for a few seconds at most). Any that can't land stop the
 * sign-out with an UnsyncedChangesError, so the caller can ask before they're
 * lost; nothing has been ended or cleared at that point. The session cookie is
 * httpOnly, so only the server can end it: if the logout request fails this
 * throws and nothing else happens — the queue stays and so does the session —
 * and the caller says so instead of showing a lock screen over a live session.
 * Once the server has confirmed, the server forgets this browser's push row
 * (the browser keeps its subscription for whoever signs in next), the outbox
 * and cached responses go, and a full page load drops every in-memory cache,
 * SWR's included, before the next person unlocks.
 */
import { authApi } from "@/lib/api";
import { clearLocalDataOnSignOut, flushOutboxBeforeSignOut } from "@/lib/offline";
import { forgetPushOnServer } from "@/lib/pushClient";

/** Changes queued offline that the pre-sign-out flush couldn't land. */
export class UnsyncedChangesError extends Error {
  constructor(public readonly count: number) {
    super(
      count === 1
        ? "1 change hasn’t synced yet. Sign out anyway and lose it?"
        : `${count} changes haven’t synced yet. Sign out anyway and lose them?`,
    );
    this.name = "UnsyncedChangesError";
  }
}

export async function signOutThisDevice({
  discardUnsynced = false,
}: { discardUnsynced?: boolean } = {}): Promise<void> {
  const left = await flushOutboxBeforeSignOut();
  if (left > 0 && !discardUnsynced) throw new UnsyncedChangesError(left);
  await authApi.logout();
  await forgetPushOnServer();
  try {
    await clearLocalDataOnSignOut();
  } catch {
    /* the reload below still drops everything held in memory */
  }
  window.location.replace("/login");
}
