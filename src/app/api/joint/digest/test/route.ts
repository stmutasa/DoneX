/**
 * "Send me one now" — builds the caller's own digest and pushes it to their
 * devices, so each person can check the thing actually arrives without
 * waiting for tomorrow morning.
 */
import { NextResponse } from "next/server";
import { requireSession, sessionRole } from "@/lib/auth";
import { generateJointDigest } from "@/lib/ai";
import { sendPushToAll } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function POST() {
  const gate = await requireSession();
  if (gate) return gate;
  const role = (await sessionRole()) ?? "owner";

  const digest = await generateJointDigest(role);
  if (!digest) {
    return NextResponse.json({
      ok: true,
      sent: 0,
      digest: "",
      message: "Nothing on the shared list for you right now, so there was nothing to send.",
    });
  }

  const sent = await sendPushToAll(
    { title: "Ours — this morning", body: digest, url: "/joint", tag: "joint-digest-test" },
    [role],
  );
  return NextResponse.json({
    ok: true,
    sent,
    digest,
    message: sent > 0 ? "Sent to your phone." : "Built it, but no device is signed up for alerts yet.",
  });
}
