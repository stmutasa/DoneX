import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { autoPickModelIfNeeded, lastFallbackEvent, refreshFallbackModel } from "@/lib/ai";
import { requireOwner } from "@/lib/auth";
import { settingsRepo } from "@/lib/db/repos";
import { JOINT_COLOR_IDS } from "@/lib/jointColors";
import { classifyCalendarLink } from "@/lib/calendarLinks";
import { resolveAiPatch } from "@/lib/aiModels";
import { KEY_ENV, keyFor } from "@/lib/ai/provider";
import type { AIProviderKind, AiKeyEvent, AppSettings, MaskedSettings, SecretMark } from "@/lib/types";

export const dynamic = "force-dynamic";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> | T[K] : T[K] };

function last4(secret: string): string {
  return secret ? secret.slice(-4) : "";
}

/** Whether a provider has a key and where it comes from — never the key itself. */
function keyMark(kind: AIProviderKind, ai: AppSettings["ai"]): SecretMark {
  const k = keyFor(kind, ai);
  return {
    set: !!k.key,
    last4: last4(k.key),
    source: k.source,
    envVar: KEY_ENV[kind],
    storedCopy: k.storedCopy,
  };
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
      partnerGoogleId: joint.partnerGoogleId,
      ownerDigestEnabled: joint.ownerDigestEnabled,
      ownerDigestTime: joint.ownerDigestTime,
      partnerDigestEnabled: joint.partnerDigestEnabled,
      partnerDigestTime: joint.partnerDigestTime,
      ownerWeekAheadEnabled: joint.ownerWeekAheadEnabled,
      ownerWeekAheadTime: joint.ownerWeekAheadTime,
      partnerWeekAheadEnabled: joint.partnerWeekAheadEnabled,
      partnerWeekAheadTime: joint.partnerWeekAheadTime,
      nudgeEnabled: joint.nudgeEnabled,
      nudgeTime: joint.nudgeTime,
      partnerPinSet: !!joint.partnerPinHash,
      ownerIcsSet: !!joint.ownerIcsUrl,
      partnerIcsSet: !!joint.partnerIcsUrl,
    },
    ai: {
      provider: ai.provider,
      model: ai.model,
      openaiModel: ai.openaiModel,
      anthropicModel: ai.anthropicModel,
      geminiModel: ai.geminiModel ?? "",
      customBaseUrl: ai.customBaseUrl,
      customModel: ai.customModel,
      fallbackProvider: ai.fallbackProvider,
      fallbackModel: ai.fallbackModel,
      fallbackModelPinned: ai.fallbackModelPinned,
      openaiKey: keyMark("openai", ai),
      anthropicKey: keyMark("anthropic", ai),
      geminiKey: keyMark("gemini", ai),
      customKey: keyMark("custom", ai),
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
    aiKeyLog: readKeyLog(),
  };
}

const aiPatchSchema = z.object({
  provider: z.enum(["openai", "anthropic", "gemini", "custom"]).optional(),
  model: z.string().optional(),
  openaiKey: z.string().optional(),
  anthropicKey: z.string().optional(),
  customBaseUrl: z.string().optional(),
  customKey: z.string().optional(),
  customModel: z.string().optional(),
  // fallbackModel is the resolved one — set fallbackModelPinned to choose it.
  fallbackModelPinned: z.string().max(200).optional(),
  fallbackProvider: z.enum(["", "openai", "anthropic", "gemini", "custom"]).optional(),
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

const featuresPatchSchema = z.object({
  assistant: z.boolean().optional(),
  nearby: z.boolean().optional(),
  walkMode: z.boolean().optional(),
});

/** A zone this server can compute dates in. Saving any other breaks every date in the app. */
function knownTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const patchSchema = z.object({
  tz: z.string().refine(knownTimeZone).optional(),
  features: featuresPatchSchema.optional(),
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
      partnerGoogleId: z.string().max(200).optional(),
      ownerDigestEnabled: z.boolean().optional(),
      ownerDigestTime: timeString.optional(),
      partnerDigestEnabled: z.boolean().optional(),
      partnerDigestTime: timeString.optional(),
      ownerWeekAheadEnabled: z.boolean().optional(),
      ownerWeekAheadTime: timeString.optional(),
      partnerWeekAheadEnabled: z.boolean().optional(),
      partnerWeekAheadTime: timeString.optional(),
      nudgeEnabled: z.boolean().optional(),
      nudgeTime: timeString.optional(),
    })
    .optional(),
});

const KEY_LOG = "ai.keyLog";
const KEY_PROVIDER = { openaiKey: "openai", anthropicKey: "anthropic", customKey: "custom" } as const;

/**
 * A key vanishing is otherwise invisible after the fact — the value is simply
 * empty. Keeping the last few saves and clears means the next "why was my key
 * gone?" can be answered from the screen rather than guessed at.
 */
function logKeyChange(provider: AiKeyEvent["provider"], action: AiKeyEvent["action"]): void {
  try {
    const next = [{ at: new Date().toISOString(), provider, action }, ...readKeyLog()].slice(0, 12);
    settingsRepo.setKV(KEY_LOG, JSON.stringify(next));
  } catch {
    // bookkeeping only
  }
}

function readKeyLog(): AiKeyEvent[] {
  try {
    const raw = JSON.parse(settingsRepo.getKV(KEY_LOG) ?? "[]");
    return Array.isArray(raw) ? (raw as AiKeyEvent[]) : [];
  } catch {
    return [];
  }
}

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
    const badZone = parsed.error.issues.some((issue) => issue.path[0] === "tz");
    return NextResponse.json({ error: badZone ? "Unknown time zone" : "Invalid settings" }, { status: 400 });
  }
  const data = parsed.data;
  const patch: DeepPartial<AppSettings> = { ...data };

  // Secret fields: "" means "leave unchanged" (drop from patch), the literal
  // "__clear__" means "wipe it" (store as real empty string).
  if (data.ai) {
    const ai = { ...data.ai };
    // Keys are read from Railway's variables now. The only thing the app
    // still does with a key is delete an older copy it stored itself.
    for (const key of ["openaiKey", "anthropicKey", "customKey"] as const) {
      if (ai[key] === "") delete ai[key];
      else if (ai[key] === "__clear__") ai[key] = "";
      else if (ai[key] !== undefined) {
        const envVar = KEY_ENV[KEY_PROVIDER[key]];
        return NextResponse.json(
          { error: `API keys are set in Railway now — add ${envVar} under your service's Variables.` },
          { status: 400 },
        );
      }
      if (ai[key] !== undefined) logKeyChange(KEY_PROVIDER[key], "cleared");
    }

    patch.ai = resolveAiPatch(settingsRepo.getApp().ai, ai);
  }
  if (data.joint) {
    const joint = { ...data.joint };
    for (const key of ["ownerIcsUrl", "partnerIcsUrl"] as const) {
      if (joint[key] === "") delete joint[key];
      else if (joint[key] === "__clear__") joint[key] = "";
      else if (joint[key]) {
        // Say why a Google view/public link can't work now, rather than saving
        // it and surfacing "feed unreachable" on the calendar later.
        const verdict = classifyCalendarLink(joint[key] as string);
        if (verdict.problem) return NextResponse.json({ error: verdict.problem }, { status: 400 });
      }
    }
    if (joint.partnerGoogleId !== undefined) {
      joint.partnerGoogleId = joint.partnerGoogleId === "__clear__" ? "" : joint.partnerGoogleId.trim();
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
    if (
      data.ai.fallbackProvider !== undefined ||
      data.ai.fallbackModelPinned !== undefined ||
      data.ai.anthropicKey ||
      data.ai.openaiKey
    ) {
      try {
        await refreshFallbackModel();
      } catch {
        // best-effort
      }
    }
  }

  return NextResponse.json(maskSettings(settingsRepo.getApp()));
}
