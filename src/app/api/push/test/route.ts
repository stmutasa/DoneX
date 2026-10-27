import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { pushRepo } from "@/lib/db/repos";
import { sendPushToAll } from "@/lib/push";

export const dynamic = "force-dynamic";

/** Owner-only, and only to the owner's devices: the partner's phone isn't
 *  part of the owner's notification check. Fails when nothing arrived. */
export async function POST() {
  const gate = await requireOwner();
  if (gate) return gate;

  if (pushRepo.list(["owner"]).length === 0) {
    return NextResponse.json(
      { error: "No device is signed up for notifications yet." },
      { status: 409 },
    );
  }
  const sent = await sendPushToAll(
    {
      title: "DoneX",
      body: "Notifications are working 🎉",
      url: "/today",
    },
    ["owner"],
  );
  if (sent === 0) {
    return NextResponse.json(
      { error: "The test didn’t reach any of your devices. Turn notifications on again here." },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true, sent });
}
