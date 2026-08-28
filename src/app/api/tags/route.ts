import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth";
import { tasksRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  return NextResponse.json({ tags: tasksRepo.allTags() });
}
