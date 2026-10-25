import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { listModels } from "@/lib/ai";
import { settingsRepo } from "@/lib/db/repos";
import { configReady, resolveConfig } from "@/lib/ai/provider";

export const dynamic = "force-dynamic";

const providerSchema = z.enum(["openai", "anthropic", "gemini", "custom"]);

export async function GET(req: Request): Promise<Response> {
  const gate = await requireOwner();
  if (gate) return gate;

  const settings = settingsRepo.getApp();
  const raw = new URL(req.url).searchParams.get("provider");
  const parsed = raw ? providerSchema.safeParse(raw) : null;
  if (raw && (!parsed || !parsed.success)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }
  const provider = parsed?.success ? parsed.data : settings.ai.provider;

  const ready = configReady(resolveConfig(provider));
  if (!ready) {
    return NextResponse.json({ error: "AI not configured" }, { status: 409 });
  }

  try {
    return NextResponse.json({ models: await listModels(provider) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not load models";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
