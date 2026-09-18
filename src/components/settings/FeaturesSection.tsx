"use client";

import { SettingsCard, useSettingsPatch, type SectionProps } from "./common";
import { SwitchRow } from "@/components/ui/Field";

/**
 * Corners of the app you can switch off. Nothing is deleted — the page and
 * everything in it stays exactly as you left it, and switching back on puts
 * the way in back where it was.
 */
export function FeaturesSection({ settings, mutate }: SectionProps) {
  const patch = useSettingsPatch(mutate);
  const f = settings.features;
  const set = (key: "assistant" | "nearby" | "walkMode", on: boolean, label: string) =>
    void patch({ features: { [key]: on } }, on ? `${label} on` : `${label} off`);

  return (
    <SettingsCard
      id="features"
      title="Features"
      description="Switch off the parts you don’t use. Nothing is deleted — turn one back on and it returns as it was."
    >
      <SwitchRow
        label="Assistant"
        description="The chat page, where you can talk to DoneX about your list. Your morning briefing and weekly review are separate and keep working either way."
        checked={f.assistant}
        onChange={(v) => set("assistant", v, "Assistant")}
      />
      <SwitchRow
        label="Nearby"
        description="The page that shows tasks with a location near where you are. Locations on individual tasks still work."
        checked={f.nearby}
        onChange={(v) => set("nearby", v, "Nearby")}
      />
      <SwitchRow
        label="Walk mode"
        description="The hands-free voice page, for talking to DoneX while walking. Turning it off also hides its voice settings."
        checked={f.walkMode}
        onChange={(v) => set("walkMode", v, "Walk mode")}
      />
    </SettingsCard>
  );
}
