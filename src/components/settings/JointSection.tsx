"use client";

import { useState } from "react";
import Link from "next/link";
import { authApi } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { useConfirm } from "@/components/ui/Confirm";
import { useToast } from "@/components/ui/Toast";
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

  const enabled = settings.joint.partnerPinSet;
  const pinValid = /^\d{4,8}$/.test(pin);

  const saveNames = () =>
    void patch(
      { joint: { ownerName: ownerName.trim(), partnerName: partnerName.trim() } },
      "Names saved",
    );

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
              The Ours tab merges both calendars. Yours uses the Google connection
              automatically{settings.joint.ownerIcsSet ? " (overridden by the feed below)" : ""};
              paste an iCal/ICS link for {settings.joint.partnerName || "your partner"} — iPhone:
              iCloud Calendar → share calendar → Public Calendar → copy the webcal link. Google:
              calendar settings → “Secret address in iCal format”.
            </p>
            <div className="mt-3 space-y-3">
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
