"use client";

import { useCallback } from "react";
import { UnsyncedChangesError, signOutThisDevice } from "@/lib/signOut";
import { useConfirm } from "@/components/ui/Confirm";
import { useToast } from "@/components/ui/Toast";

/**
 * Sign-out for a button: asks before throwing away offline changes that
 * couldn't sync, and says so when the server couldn't be reached (the
 * session is still live then, so nothing changes on the device).
 */
export function useSignOut(): () => Promise<void> {
  const confirm = useConfirm();
  const toast = useToast();

  return useCallback(async () => {
    try {
      await signOutThisDevice();
    } catch (err) {
      if (!(err instanceof UnsyncedChangesError)) {
        toast.error(err instanceof Error ? err.message : "Could not sign out");
        return;
      }
      const ok = await confirm({
        title: "Some changes haven’t synced",
        message: err.message,
        confirmLabel: "Sign out",
        destructive: true,
      });
      if (!ok) return;
      try {
        await signOutThisDevice({ discardUnsynced: true });
      } catch (again) {
        toast.error(again instanceof Error ? again.message : "Could not sign out");
      }
    }
  }, [confirm, toast]);
}
