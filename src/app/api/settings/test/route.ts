import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { testProvider } from "@/lib/ai";
import { settingsRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  provider: z.enum(["openai", "anthropic", "custom"]).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const gate = await requireSession();
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
  const key =
    provider === "openai"
      ? settings.ai.openaiKey
      : provider === "anthropic"
        ? settings.ai.anthropicKey
        : settings.ai.customKey;
  const missingBase = provider === "custom" && !settings.ai.customBaseUrl.trim();
  if (!key.trim() || missingBase) {
    return NextResponse.json({ error: "AI not configured" }, { status: 409 });
  }

  return NextResponse.json(await testProvider(provider));
}
