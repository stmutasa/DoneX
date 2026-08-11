"use client";

import { useEffect } from "react";
import useSWR from "swr";
import { fetcher, keys } from "@/lib/api";
import type { MaskedSettings } from "@/lib/types";
import { Page } from "@/components/shell/Page";
import { PageHeader, Skeleton } from "@/components/ui/Misc";
import { AiSection } from "@/components/settings/AiSection";
import { CaptureSection } from "@/components/settings/CaptureSection";
import { GoogleSection } from "@/components/settings/GoogleSection";
import { NotificationsSection } from "@/components/settings/NotificationsSection";
import { VoiceSection } from "@/components/settings/VoiceSection";
import { AboutSection } from "@/components/settings/AboutSection";
import {
  AppearanceSection,
  DataSection,
  ProfileSection,
} from "@/components/settings/MiscSections";

export default function SettingsPage() {
  const { data: settings, isLoading, mutate } = useSWR<MaskedSettings>(keys.settings(), fetcher);

  // Deep links like /settings#ai land after the sections render.
  useEffect(() => {
    if (!settings) return;
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const t = window.setTimeout(() => {
      document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    return () => window.clearTimeout(t);
  }, [settings]);

  return (
    <Page>
      <PageHeader title="Settings" subtitle="Make DoneX yours." />

      {isLoading || !settings ? (
        <div className="space-y-4">
          {["h-40", "h-56", "h-48", "h-40"].map((h, i) => (
            <Skeleton key={i} className={`w-full rounded-2xl ${h}`} />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <ProfileSection settings={settings} mutate={mutate} />
          <AiSection settings={settings} mutate={mutate} />
          <VoiceSection settings={settings} mutate={mutate} />
          <NotificationsSection settings={settings} mutate={mutate} />
          <GoogleSection settings={settings} mutate={mutate} />
          <CaptureSection settings={settings} />
          <AppearanceSection />
          <DataSection />
          <AboutSection />
        </div>
      )}
    </Page>
  );
}
