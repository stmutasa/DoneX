import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { conversationsRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const gate = await requireOwner();
  if (gate) return gate;
  return NextResponse.json({ conversations: conversationsRepo.listRecent(30) });
}

export async function POST(): Promise<Response> {
  const gate = await requireOwner();
  if (gate) return gate;
  return NextResponse.json({ conversation: conversationsRepo.create() });
}
