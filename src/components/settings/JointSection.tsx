"use client";

import { useState } from "react";
import Link from "next/link";
import { authApi } from "@/lib/api";
import { JOINT_COLOR_IDS, hueVar, normalizeJointColor, type JointColorId } from "@/lib/jointColors";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { useConfirm } from "@/components/ui/Confirm";
import { useToast } from "@/components/ui/Toast";
import { Segmented } from "@/components/ui/Segmented";
import { IconCheck } from "@/components/ui/icons";
import { Divider, SettingsCard, useSettingsPatch, type SectionProps } from "./common";

/**
 * The shared list: names for the two of you, and the partner PIN that opens
 * the joint tab (and nothing else) on the other phone.
 */
export function JointSection({ settings, mutate }: SectionProps) {
  const patch = useSettingsPatch(mutate);
  const confirm = useConfirm();
  const toast = useToast();
  const [ownerName, setOwnerName] = useState(settings.joint.ownerName);
  const [partnerName, setPartnerName] = useState(settings.joint.partnerName);
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [saving, setSaving] = useState(false);
  const [ownerIcs, setOwnerIcs] = useState("");
  const [partnerIcs, setPartnerIcs] = useState("");
  const [partnerCalKind, setPartnerCalKind] = useState<"icloud" | "google">("icloud");
  const [ownerColor, setOwnerColor] = useState<JointColorId>(
    normalizeJointColor(settings.joint.ownerColor, "blue"),
  );
  const [partnerColor, setPartnerColor] = useState<JointColorId>(
    normalizeJointColor(settings.joint.partnerColor, "pink"),
  );

  const enabled = settings.joint.partnerPinSet;
  const pinValid = /^\d{4,8}$/.test(pin);

  const saveNames = () =>
    void patch(
      { joint: { ownerName: ownerName.trim(), partnerName: partnerName.trim() } },
      "Names saved",
    );

  const pickOwnerColor = (id: JointColorId) => {
    setOwnerColor(id);
    void patch({ joint: { ownerColor: id } }, "Color saved");
  };
  const pickPartnerColor = (id: JointColorId) => {
    setPartnerColor(id);
    void patch({ joint: { partnerColor: id } }, "Color saved");
  };

  const savePin = async () => {
    if (!pinValid) return;
    setSaving(true);
    try {
      await authApi.setPartnerPin(pin);
      await mutate();
      setPin("");
      setPinOpen(false);
      toast.success("Partner PIN set — the shared list is live");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not set the PIN");
    } finally {
      setSaving(false);
    }
  };

  const disable = async () => {
    const ok = await confirm({
      title: "Turn off the shared list?",
      message:
        "Your partner's PIN stops working and their devices are signed out. Joint tasks are kept.",
      confirmLabel: "Turn off",
      destructive: true,
    });
    if (!ok) return;
    try {
      await authApi.setPartnerPin(null);
      await mutate();
      toast.success("Shared list turned off");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not turn it off");
    }
  };

  return (
    <SettingsCard
      id="joint"
      title="Shared list"
      description="A second PIN that opens ONLY the joint tab — nothing else of yours."
    >
      <div className="grid grid-cols-2 gap-2">
        <Input
          label="Your name"
          value={ownerName}
          placeholder="Me"
          onChange={(e) => setOwnerName(e.target.value.slice(0, 30))}
          onBlur={saveNames}
        />
        <Input
          label="Partner's name"
          value={partnerName}
          placeholder="Partner"
          onChange={(e) => setPartnerName(e.target.value.slice(0, 30))}
          onBlur={saveNames}
        />
      </div>

      <div className="space-y-3">
        <ColorRow label="Your color" value={ownerColor} onPick={pickOwnerColor} />
        <ColorRow
          label={`${partnerName.trim() || "Partner"}'s color`}
          value={partnerColor}
          onPick={pickPartnerColor}
        />
        <p className="text-[12px] leading-snug text-faint">
          These tint the joint calendar and the “who added it” chips — for both of you.
        </p>
      </div>

      <Divider />

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[15px] text-ink">Partner PIN</div>
          <div className="mt-0.5 text-[13px] text-muted">
            {enabled
              ? "Set — they sign in with it at your DoneX address."
              : "Not set — the shared list is off until you create one."}
          </div>
        </div>
        <Button size="sm" onClick={() => setPinOpen((o) => !o)}>
          {pinOpen ? "Cancel" : enabled ? "New PIN" : "Set PIN"}
        </Button>
      </div>

      {pinOpen ? (
        <div className="space-y-3 rounded-2xl border border-stroke bg-sunken p-3.5">
          <Input
            label="Partner PIN"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            placeholder="4–8 digits, different from yours"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
          />
          <Button variant="primary" block disabled={!pinValid} loading={saving} onClick={savePin}>
            {enabled ? "Replace PIN" : "Turn on the shared list"}
          </Button>
        </div>
      ) : null}

      {enabled ? (
        <>
          <p className="text-[12px] leading-snug text-faint">
            On their iPhone: open your DoneX address in Safari → Share → Add to Home Screen →
            sign in with the partner PIN. They land on{" "}
            <Link href="/joint" className="font-medium text-accent">
              the shared list
            </Link>{" "}
            and can see nothing else.
          </p>

          <Divider />

          <div>
            <div className="text-[15px] text-ink">Joint calendar feeds</div>
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
              The Ours tab merges both calendars. Yours uses your Google connection
              automatically{settings.joint.ownerIcsSet ? " (overridden by the feed below)" : ""}.
              For {settings.joint.partnerName || "your partner"}, pick where their calendar
              lives and paste its link — either kind syncs the same way.
            </p>
            <div className="mt-3 space-y-3">
              <Segmented
                size="sm"
                ariaLabel="Partner calendar kind"
                value={partnerCalKind}
                onChange={setPartnerCalKind}
                options={[
                  { value: "icloud" as const, label: "iPhone / iCloud" },
                  { value: "google" as const, label: "Google Calendar" },
                ]}
              />
              <p className="text-[12px] leading-snug text-faint">
                {partnerCalKind === "icloud"
                  ? "On their iPhone: Calendar app → Calendars → ⓘ next to their calendar → Public Calendar → Share Link → copy, then paste it here."
                  : "On calendar.google.com: Settings → their calendar → Integrate calendar → copy the “Secret address in iCal format”, then paste it here. Their events stay private to you two."}
              </p>
              <Input
                label={`${settings.joint.partnerName || "Partner"}'s calendar link`}
                placeholder={settings.joint.partnerIcsSet ? "Saved — paste to replace" : "webcal://… or https://…ics"}
                value={partnerIcs}
                onChange={(e) => setPartnerIcs(e.target.value)}
                onBlur={() => {
                  const v = partnerIcs.trim();
                  if (v) void patch({ joint: { partnerIcsUrl: v } }, "Partner calendar linked");
                }}
              />
              <Input
                label="Your calendar link (optional)"
                placeholder={settings.joint.ownerIcsSet ? "Saved — paste to replace" : "Leave empty to use Google"}
                value={ownerIcs}
                onChange={(e) => setOwnerIcs(e.target.value)}
                onBlur={() => {
                  const v = ownerIcs.trim();
                  if (v) void patch({ joint: { ownerIcsUrl: v } }, "Your calendar feed linked");
                }}
              />
            </div>
          </div>

          <Divider />
          <Button variant="danger" size="sm" onClick={disable}>
            Turn off shared list
          </Button>
        </>
      ) : null}
    </SettingsCard>
  );
}

/** A row of color swatches; the picked one is ringed and checked. */
function ColorRow({
  label,
  value,
  onPick,
}: {
  label: string;
  value: JointColorId;
  onPick: (id: JointColorId) => void;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-[13px] font-medium text-muted">{label}</span>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {JOINT_COLOR_IDS.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={id === value}
            aria-label={id}
            title={id}
            onClick={() => onPick(id)}
            className={cn(
              "grid h-8 w-8 place-items-center rounded-full border-2 transition-transform",
              id === value ? "scale-110 border-ink" : "border-transparent",
            )}
            style={{ background: hueVar(id) }}
          >
            {id === value ? (
              <IconCheck className="h-3.5 w-3.5 text-white" strokeWidth={3} />
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}
