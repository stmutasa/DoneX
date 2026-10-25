import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { testProvider } from "@/lib/ai";
import { settingsRepo } from "@/lib/db/repos";
import { configReady, resolveConfig } from "@/lib/ai/provider";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  provider: z.enum(["openai", "anthropic", "gemini", "custom"]).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const gate = await requireOwner();
  if (gate) return gate;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    raw = {};
  }
  const parsed = bodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  const settings = settingsRepo.getApp();
  const provider = parsed.data.provider ?? settings.ai.provider;
  const ready = configReady(resolveConfig(provider));
  if (!ready) {
    return NextResponse.json({ error: "AI not configured" }, { status: 409 });
  }

  return NextResponse.json(await testProvider(provider));
}
