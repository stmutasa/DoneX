import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth";
import { sendPushToAll } from "@/lib/push";

export const dynamic = "force-dynamic";

export async function POST() {
  const gate = await requireSession();
  if (gate) return gate;

  const sent = await sendPushToAll({
    title: "DoneX",
    body: "Notifications are working 🎉",
    url: "/today",
  });
  return NextResponse.json({ ok: true, sent });
}
