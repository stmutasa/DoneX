import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { autoPickModelIfNeeded } from "@/lib/ai";
import { requireSession } from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";
import type { AppSettings, MaskedSettings } from "@/lib/types";

export const dynamic = "force-dynamic";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> | T[K] : T[K] };

function last4(secret: string): string {
  return secret ? secret.slice(-4) : "";
}

function maskSettings(settings: AppSettings): MaskedSettings {
  const { ai, google, vapid, pinHash, ...rest } = settings;
  return {
    ...rest,
    hasPin: !!pinHash,
    ai: {
      provider: ai.provider,
      model: ai.model,
      customBaseUrl: ai.customBaseUrl,
      customModel: ai.customModel,
      openaiKey: { set: !!ai.openaiKey, last4: last4(ai.openaiKey) },
      anthropicKey: { set: !!ai.anthropicKey, last4: last4(ai.anthropicKey) },
      customKey: { set: !!ai.customKey, last4: last4(ai.customKey) },
    },
    google: {
      clientId: google.clientId,
      gmailScanEnabled: google.gmailScanEnabled,
      gmailQuery: google.gmailQuery,
      clientSecret: { set: !!google.clientSecret, last4: last4(google.clientSecret) },
    },
    pushConfigured: !!vapid,
  };
}

const aiPatchSchema = z.object({
  provider: z.enum(["openai", "anthropic", "custom"]).optional(),
  model: z.string().optional(),
  openaiKey: z.string().optional(),
  anthropicKey: z.string().optional(),
  customBaseUrl: z.string().optional(),
  customKey: z.string().optional(),
  customModel: z.string().optional(),
});

const voicePatchSchema = z.object({
  voiceURI: z.string().optional(),
  rate: z.number().min(0.5).max(2).optional(),
  autoListen: z.boolean().optional(),
});

const notificationsPatchSchema = z.object({
  remindersEnabled: z.boolean().optional(),
  briefingEnabled: z.boolean().optional(),
  briefingTime: z.string().optional(),
  weeklyReviewEnabled: z.boolean().optional(),
  weeklyDay: z.number().int().min(0).max(6).optional(),
  weeklyTime: z.string().optional(),
});

const googlePatchSchema = z.object({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  gmailScanEnabled: z.boolean().optional(),
  gmailQuery: z.string().max(300).optional(),
});

const patchSchema = z.object({
  tz: z.string().optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
  ai: aiPatchSchema.optional(),
  voice: voicePatchSchema.optional(),
  notifications: notificationsPatchSchema.optional(),
  google: googlePatchSchema.optional(),
});

export async function GET() {
  const gate = await requireSession();
  if (gate) return gate;

  return NextResponse.json(maskSettings(settingsRepo.getApp()));
}

export async function PATCH(req: NextRequest) {
  const gate = await requireSession();
  if (gate) return gate;

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid settings" }, { status: 400 });
  }
  const data = parsed.data;
  const patch: DeepPartial<AppSettings> = { ...data };

  // Secret fields: "" means "leave unchanged" (drop from patch), the literal
  // "__clear__" means "wipe it" (store as real empty string).
  if (data.ai) {
    const ai = { ...data.ai };
    for (const key of ["openaiKey", "anthropicKey", "customKey"] as const) {
      if (ai[key] === "") delete ai[key];
      else if (ai[key] === "__clear__") ai[key] = "";
    }
    patch.ai = ai;
  }
  if (data.google) {
    const google = { ...data.google };
    if (google.clientSecret === "") delete google.clientSecret;
    else if (google.clientSecret === "__clear__") google.clientSecret = "";
    patch.google = google;
  }

  settingsRepo.updateApp(patch);

  if (data.ai) {
    try {
      await autoPickModelIfNeeded();
    } catch {
      // best-effort only — provider may not be reachable yet
    }
  }

  return NextResponse.json(maskSettings(settingsRepo.getApp()));
}
