/**
 * Save the model choices, then actually try them and say what happened.
 *
 * The picker used to save on every change, which made it impossible to tell a
 * saved setting from one that had quietly gone somewhere else. This is the
 * explicit version: one button, one write, and a straight answer about what is
 * now in force and whether it works.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/lib/auth";
import { refreshFallbackModel, testProvider } from "@/lib/ai";
import { settingsRepo } from "@/lib/db/repos";
import { backupCollides, resolveAiPatch } from "@/lib/aiModels";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  model: z.string().max(200).optional(),
  fallbackProvider: z.enum(["", "openai", "anthropic", "custom"]).optional(),
  /** skip the live calls and just save */
  test: z.boolean().optional(),
});

export interface SaveModelsResult {
  saved: {
    provider: string;
    model: string;
    fallbackProvider: string;
    fallbackModel: string;
  };
  /** null when the caller asked not to test */
  primary: { ok: boolean; message: string } | null;
  backup: { ok: boolean; message: string } | null;
  /** set when the backup was dropped because it matched the active provider */
  note: string | null;
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid model selection" }, { status: 400 });
  }
  const { model, fallbackProvider, test = true } = parsed.data;

  const before = settingsRepo.getApp().ai;
  const wanted = {
    ...(model !== undefined ? { model: model.trim() } : {}),
    ...(fallbackProvider !== undefined ? { fallbackProvider } : {}),
  };
  const dropped = backupCollides(before, wanted);

  settingsRepo.updateApp({ ai: resolveAiPatch(before, wanted) });

  // Resolve the standby's newest model now, so what we report is what a real
  // failover would reach for.
  try {
    await refreshFallbackModel();
  } catch {
    // best effort — the save itself has already happened
  }

  const ai = settingsRepo.getApp().ai;
  const result: SaveModelsResult = {
    saved: {
      provider: ai.provider,
      model: ai.model,
      fallbackProvider: ai.fallbackProvider,
      fallbackModel: ai.fallbackModel,
    },
    primary: null,
    backup: null,
    note: dropped
      ? "A backup on the same provider can't stand in for it, so the backup was turned off."
      : null,
  };

  if (test) {
    const [primary, backup] = await Promise.all([
      testProvider(ai.provider),
      ai.fallbackProvider ? testProvider(ai.fallbackProvider) : Promise.resolve(null),
    ]);
    result.primary = primary;
    result.backup = backup;
  }

  return NextResponse.json(result);
}
