"use client";

import { useMemo, useState } from "react";
import { useTTS } from "@/hooks/useTTS";
import { Select, SwitchRow } from "@/components/ui/Field";
import { IconButton } from "@/components/ui/Button";
import { IconVolume } from "@/components/ui/icons";
import { SettingsCard, useSettingsPatch, type SectionProps } from "./common";

const SAMPLE = "Good morning. You have three things on today — want me to plan them out?";

export function VoiceSection({ settings, mutate }: SectionProps) {
  const patch = useSettingsPatch(mutate);
  const tts = useTTS();
  const [rate, setRate] = useState(settings.voice.rate ?? 1);
  // Local, optimistic copy: patch() awaits a server round-trip before the
  // settings prop updates, so reading settings.voice.voiceURI straight from
  // props means a preview tapped right after picking a voice would still
  // play the OLD voice. Update this instantly on selection instead.
  const [voiceURI, setVoiceURI] = useState(settings.voice.voiceURI);

  const grouped = useMemo(() => {
    const lang = (typeof navigator !== "undefined" ? navigator.language : "en").slice(0, 2);
    const matching = tts.voices.filter((v) => v.lang.toLowerCase().startsWith(lang.toLowerCase()));
    const pool = matching.length ? matching : tts.voices;
    const local = pool.filter((v) => v.localService);
    const remote = pool.filter((v) => !v.localService);
    return { local, remote };
  }, [tts.voices]);

  const speakSample = () => tts.speak(SAMPLE, { voiceURI: voiceURI || undefined, rate });

  return (
    <SettingsCard
      id="voice"
      title="Voice"
      description="How DoneX sounds when it talks back on your walks."
    >
      {tts.supported ? (
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[13px] font-medium text-muted">Voice</span>
            <IconButton label="Preview voice" size="sm" onClick={speakSample}>
              <IconVolume className="h-4 w-4" />
            </IconButton>
          </div>
          <Select
            value={voiceURI}
            onChange={(e) => {
              const next = e.target.value;
              setVoiceURI(next);
              void patch({ voice: { voiceURI: next } });
            }}
          >
            <option value="">System default</option>
            {grouped.local.length ? (
              <optgroup label="On device">
                {grouped.local.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </optgroup>
            ) : null}
            {grouped.remote.length ? (
              <optgroup label="Network">
                {grouped.remote.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </optgroup>
            ) : null}
          </Select>
          {tts.voices.length === 0 ? (
            <p className="mt-1.5 text-[12px] text-faint">
              Voices load a moment after the page — tap preview and the list will fill in.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-[13.5px] text-muted">
          This browser doesn’t expose speech synthesis. DoneX will still show replies as text.
        </p>
      )}

      <div>
        <div className="mb-1.5 flex items-center justify-between text-[13px] font-medium text-muted">
          <span>Speaking rate</span>
          <span className="tabular-nums text-ink">{rate.toFixed(2)}×</span>
        </div>
        <input
          type="range"
          min={0.5}
          max={1.5}
          step={0.05}
          value={rate}
          aria-label="Speaking rate"
          onChange={(e) => setRate(Number(e.target.value))}
          onPointerUp={() => void patch({ voice: { rate } })}
          onKeyUp={() => void patch({ voice: { rate } })}
          className="h-11 w-full accent-accent"
        />
      </div>

      <SwitchRow
        label="Hands-free by default"
        description="Keep listening after each reply in walk mode."
        checked={settings.voice.autoListen}
        onChange={(v) => void patch({ voice: { autoListen: v } })}
      />
    </SettingsCard>
  );
}
