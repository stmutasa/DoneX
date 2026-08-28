import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { autoPickModelIfNeeded, lastFallbackEvent, refreshFallbackModel } from "@/lib/ai";
import { requireOwner } from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";
import { JOINT_COLOR_IDS } from "@/lib/jointColors";
import type { AppSettings, MaskedSettings } from "@/lib/types";

export const dynamic = "force-dynamic";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> | T[K] : T[K] };

function last4(secret: string): string {
  return secret ? secret.slice(-4) : "";
}

function maskSettings(settings: AppSettings): MaskedSettings {
  const { ai, google, vapid, pinHash, joint, ...rest } = settings;
  return {
    ...rest,
    hasPin: !!pinHash,
    joint: {
      ownerName: joint.ownerName,
      partnerName: joint.partnerName,
      ownerColor: joint.ownerColor,
      partnerColor: joint.partnerColor,
      partnerPinSet: !!joint.partnerPinHash,
      ownerIcsSet: !!joint.ownerIcsUrl,
      partnerIcsSet: !!joint.partnerIcsUrl,
    },
    ai: {
      provider: ai.provider,
      model: ai.model,
      customBaseUrl: ai.customBaseUrl,
      customModel: ai.customModel,
      fallbackProvider: ai.fallbackProvider,
      fallbackModel: ai.fallbackModel,
      openaiKey: { set: !!ai.openaiKey, last4: last4(ai.openaiKey) },
      anthropicKey: { set: !!ai.anthropicKey, last4: last4(ai.anthropicKey) },
      customKey: { set: !!ai.customKey, last4: last4(ai.customKey) },
    },
    google: {
      clientId: google.clientId,
      gmailScanEnabled: google.gmailScanEnabled,
      gmailQuery: google.gmailQuery,
      clientSecret: { set: !!google.clientSecret, last4: last4(google.clientSecret) },
      mapsApiKey: { set: !!google.mapsApiKey, last4: last4(google.mapsApiKey) },
    },
    pushConfigured: !!vapid,
    aiFallback: lastFallbackEvent(),
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
  // fallbackModel is resolved server-side to the provider's newest — not set here.
  fallbackProvider: z.enum(["", "openai", "anthropic", "custom"]).optional(),
});

const voicePatchSchema = z.object({
  voiceURI: z.string().optional(),
  rate: z.number().min(0.5).max(2).optional(),
  autoListen: z.boolean().optional(),
});

const timeString = z.string().regex(/^\d{1,2}:\d{2}$/, "Expected HH:mm");

const notificationsPatchSchema = z.object({
  remindersEnabled: z.boolean().optional(),
  briefingEnabled: z.boolean().optional(),
  briefingTime: timeString.optional(),
  weeklyReviewEnabled: z.boolean().optional(),
  weeklyDay: z.number().int().min(0).max(6).optional(),
  weeklyTime: timeString.optional(),
  quietHoursEnabled: z.boolean().optional(),
  quietStart: timeString.optional(),
  quietEnd: timeString.optional(),
});

const googlePatchSchema = z.object({
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  gmailScanEnabled: z.boolean().optional(),
  gmailQuery: z.string().max(300).optional(),
  mapsApiKey: z.string().optional(),
});

const patchSchema = z.object({
  tz: z.string().optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
  ai: aiPatchSchema.optional(),
  voice: voicePatchSchema.optional(),
  notifications: notificationsPatchSchema.optional(),
  google: googlePatchSchema.optional(),
  smsCaptureEnabled: z.boolean().optional(),
  joint: z
    .object({
      ownerName: z.string().max(30).optional(),
      partnerName: z.string().max(30).optional(),
      ownerIcsUrl: z.string().max(2000).optional(),
      partnerIcsUrl: z.string().max(2000).optional(),
      ownerColor: z.enum(JOINT_COLOR_IDS).optional(),
      partnerColor: z.enum(JOINT_COLOR_IDS).optional(),
    })
    .optional(),
});

export async function GET() {
  const gate = await requireOwner();
  if (gate) return gate;

  return NextResponse.json(maskSettings(settingsRepo.getApp()));
}

export async function PATCH(req: NextRequest) {
  const gate = await requireOwner();
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
  if (data.joint) {
    const joint = { ...data.joint };
    for (const key of ["ownerIcsUrl", "partnerIcsUrl"] as const) {
      if (joint[key] === "") delete joint[key];
      else if (joint[key] === "__clear__") joint[key] = "";
    }
    patch.joint = joint;
  }
  if (data.google) {
    const google = { ...data.google };
    for (const key of ["clientSecret", "mapsApiKey"] as const) {
      if (google[key] === "") delete google[key];
      else if (google[key] === "__clear__") google[key] = "";
    }
    patch.google = google;
  }

  settingsRepo.updateApp(patch);

  if (data.ai) {
    try {
      await autoPickModelIfNeeded();
    } catch {
      // best-effort only — provider may not be reachable yet
    }
    // Picking a standby provider immediately resolves its newest model, so the
    // response already carries what the UI should display.
    if (data.ai.fallbackProvider !== undefined || data.ai.anthropicKey || data.ai.openaiKey) {
      try {
        await refreshFallbackModel();
      } catch {
        // best-effort
      }
    }
  }

  return NextResponse.json(maskSettings(settingsRepo.getApp()));
}
