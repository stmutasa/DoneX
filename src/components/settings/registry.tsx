"use client";

/**
 * Single source of truth for the Settings information architecture: slug →
 * section. The hub page renders these as grouped menu rows; the [section]
 * sub-page renders one entry. Slugs double as the legacy #hash deep-link ids,
 * so /settings#ai from old links keeps landing in the right place.
 */
import type { ComponentType, ReactNode } from "react";
import type { KeyedMutator } from "swr";
import type { GoogleStatus, MaskedSettings } from "@/lib/types";
import { APP_VERSION } from "@/lib/version";
import {
  IconBell,
  IconCalendar,
  IconDownload,
  IconInbox,
  IconKeyboard,
  IconList,
  IconSparkles,
  IconSun,
  IconVolume,
  IconWand,
} from "@/components/ui/icons";
import { AboutSection } from "./AboutSection";
import { AiSection } from "./AiSection";
import { CaptureSection } from "./CaptureSection";
import { GoogleSection } from "./GoogleSection";
import { NotificationsSection } from "./NotificationsSection";
import { TriageLessonsSection } from "./TriageLessonsSection";
import { VoiceSection } from "./VoiceSection";
import { AppearanceSection, DataSection, ProfileSection } from "./MiscSections";

export interface SectionDef {
  slug: string;
  title: string;
  icon: ComponentType<{ className?: string }>;
  /** one-line live status under the row title */
  subtitle: (settings: MaskedSettings, google: GoogleStatus | undefined) => string;
  render: (settings: MaskedSettings, mutate: KeyedMutator<MaskedSettings>) => ReactNode;
}

export interface SectionGroup {
  label: string;
  sections: SectionDef[];
}

const PROVIDER_LABEL: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  custom: "Custom",
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function clock(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""} ${suffix}`;
}

export const SETTINGS_GROUPS: SectionGroup[] = [
  {
    label: "You",
    sections: [
      {
        slug: "profile",
        title: "Profile & security",
        icon: IconKeyboard,
        subtitle: (s) => `${s.tz}${s.hasPin ? " · PIN set" : ""}`,
        render: (s, m) => <ProfileSection settings={s} mutate={m} />,
      },
      {
        slug: "appearance",
        title: "Appearance",
        icon: IconSun,
        subtitle: (s) =>
          `${s.theme === "system" ? "System theme" : s.theme === "dark" ? "Dark theme" : "Light theme"} · install app`,
        render: () => <AppearanceSection />,
      },
    ],
  },
  {
    label: "Intelligence",
    sections: [
      {
        slug: "ai",
        title: "AI models",
        icon: IconSparkles,
        subtitle: (s) => {
          const model = (s.ai.provider === "custom" ? s.ai.customModel : s.ai.model) || "auto";
          const base = `${PROVIDER_LABEL[s.ai.provider] ?? s.ai.provider} · ${model}`;
          return s.ai.fallbackProvider
            ? `${base} · backup ${PROVIDER_LABEL[s.ai.fallbackProvider] ?? s.ai.fallbackProvider}`
            : base;
        },
        render: (s, m) => <AiSection settings={s} mutate={m} />,
      },
      {
        slug: "voice",
        title: "Voice",
        icon: IconVolume,
        subtitle: (s) =>
          `${s.voice.voiceURI ? "Custom voice" : "System voice"} · ${s.voice.autoListen ? "hands-free on" : "hands-free off"}`,
        render: (s, m) => <VoiceSection settings={s} mutate={m} />,
      },
    ],
  },
  {
    label: "Connections",
    sections: [
      {
        slug: "google",
        title: "Google Calendar & Gmail",
        icon: IconCalendar,
        subtitle: (s, g) =>
          g?.connected
            ? `${g.email ?? "Connected"}${s.google.gmailScanEnabled ? " · scanning hourly" : ""}`
            : "Not connected",
        render: (s, m) => <GoogleSection settings={s} mutate={m} />,
      },
      {
        slug: "capture",
        title: "SMS capture",
        icon: IconInbox,
        subtitle: (s) => (s.smsCaptureEnabled ? "Accepting forwarded texts" : "Off"),
        render: (s, m) => <CaptureSection settings={s} mutate={m} />,
      },
    ],
  },
  {
    label: "Alerts & triage",
    sections: [
      {
        slug: "notifications",
        title: "Notifications",
        icon: IconBell,
        subtitle: (s) => {
          const n = s.notifications;
          const bits = [
            n.briefingEnabled ? `briefing ${clock(n.briefingTime)}` : "briefing off",
            n.weeklyReviewEnabled ? `review ${WEEKDAYS[n.weeklyDay] ?? "Sun"}` : "review off",
          ];
          if (n.quietHoursEnabled) bits.push(`quiet ${clock(n.quietStart)}–${clock(n.quietEnd)}`);
          return bits.join(" · ");
        },
        render: (s, m) => <NotificationsSection settings={s} mutate={m} />,
      },
      {
        slug: "lessons",
        title: "Triage lessons",
        icon: IconWand,
        subtitle: () => "Your corrections that tune the inbox AI",
        render: () => <TriageLessonsSection />,
      },
    ],
  },
  {
    label: "App",
    sections: [
      {
        slug: "data",
        title: "Data",
        icon: IconDownload,
        subtitle: () => "Export & import everything",
        render: () => <DataSection />,
      },
      {
        slug: "about",
        title: "About",
        icon: IconList,
        subtitle: () => `Version ${APP_VERSION}`,
        render: (s, m) => <AboutSection settings={s} mutate={m} />,
      },
    ],
  },
];

export const SETTINGS_SECTIONS: SectionDef[] = SETTINGS_GROUPS.flatMap((g) => g.sections);

export function findSection(slug: string): SectionDef | null {
  return SETTINGS_SECTIONS.find((s) => s.slug === slug) ?? null;
}
