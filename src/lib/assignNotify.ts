/**
 * Delivery side of task tagging: works out whether an alert is owed (see
 * assign.ts for the rules) and pushes it to that person's devices.
 */
import "server-only";
import { assignmentAlert } from "@/lib/assign";
import { settingsRepo } from "@/lib/db/repos";
import { sendPushToAll } from "@/lib/push";
import type { SessionRole, Task } from "@/lib/types";

/** Best effort: a push that can't be delivered must never fail the write. */
export async function alertAssignee(
  task: Task,
  actor: SessionRole,
  previous: SessionRole | null,
): Promise<void> {
  const joint = settingsRepo.getApp().joint;
  const alert = assignmentAlert({
    task,
    actor,
    previous,
    names: { owner: joint.ownerName, partner: joint.partnerName },
  });
  if (!alert) return;

  try {
    await sendPushToAll(
      { title: alert.title, body: alert.body, url: alert.url, tag: alert.tag },
      [alert.to],
    );
  } catch (err) {
    console.error("[assign] alert failed", err);
  }
}
