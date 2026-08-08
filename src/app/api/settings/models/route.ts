import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth";
import { listModels } from "@/lib/ai";
import { settingsRepo } from "@/lib/db/repos";

export const dynamic = "force-dynamic";

const providerSchema = z.enum(["openai", "anthropic", "custom"]);

export async function GET(req: Request): Promise<Response> {
  const gate = await requireSession();
  if (gate) return gate;

  const settings = settingsRepo.getApp();
  const raw = new URL(req.url).searchParams.get("provider");
  const parsed = raw ? providerSchema.safeParse(raw) : null;
  if (raw && (!parsed || !parsed.success)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }
  const provider = parsed?.success ? parsed.data : settings.ai.provider;

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

  try {
    return NextResponse.json({ models: await listModels(provider) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not load models";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
