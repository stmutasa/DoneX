import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { ImportError, importAll } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ version: z.literal(1) }).passthrough();

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid export file" }, { status: 400 });
  }

  // Nothing is written unless the whole file goes in.
  try {
    return NextResponse.json(importAll(parsed.data));
  } catch (err) {
    if (err instanceof ImportError) {
      return NextResponse.json({ error: `Nothing was imported. ${err.message}` }, { status: 400 });
    }
    console.error("[import]", err);
    return NextResponse.json({ error: "Could not import that file" }, { status: 500 });
  }
}
