"use client";

import { useEffect, useState } from "react";
import { settingsApi } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/Confirm";
import { useToast } from "@/components/ui/Toast";
import { Accordion, CopyField, Divider, SettingsCard, Steps, type SectionProps } from "./common";

/**
 * A secret, read-only link to your open tasks — so another chat window, or
 * anything else that can fetch a URL, can see what's on your plate without
 * being handed a way into the app.
 */
export function ShareSection({ settings, mutate }: SectionProps) {
  const confirm = useConfirm();
  const toast = useToast();
  const [origin, setOrigin] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);

  const token = settings.shareToken;
  // Only worth mentioning the other half of the list once there is one.
  const partner = settings.joint.partnerPinSet
    ? settings.joint.partnerName || "your partner"
    : "";
  const base = origin || "…";
  const link = token ? `${base}/api/share/${token}` : "";

  const create = async () => {
    setBusy(true);
    try {
      await settingsApi.createShareToken();
      await mutate();
      toast.success(token ? "New link ready — the old one is dead" : "Link ready");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not make a link");
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    const ok = await confirm({
      title: "Replace the link?",
      message:
        "The current link stops working immediately. Anywhere you have pasted it — another chat, a note — will need the new one.",
      confirmLabel: "Replace",
      destructive: true,
    });
    if (ok) await create();
  };

  const revoke = async () => {
    const ok = await confirm({
      title: "Turn off the link?",
      message: "The link stops working immediately and nothing can read your tasks through it.",
      confirmLabel: "Turn off",
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await settingsApi.revokeShareToken();
      await mutate();
      toast.success("Link turned off");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not turn it off");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      id="share"
      title="Share link"
      description="A read-only address for your open tasks, for another chat window to read."
    >
      {!token ? (
        <>
          <p className="text-[13.5px] leading-relaxed text-muted">
            Makes a secret web address that returns your open tasks as plain text — grouped
            into overdue, today, the next week, later and undated, with due dates, projects,
            tags and notes. Paste it into another chat and ask that assistant to read it;
            it sees whatever is on your list at the moment it looks, not a copy that goes
            stale.
          </p>
          <p className="text-[12px] leading-snug text-faint">
            It is read-only — nothing can be changed through it — and it carries tasks only:
            no settings and no keys
            {partner ? `, and none of the shared work ${partner} has taken on` : ""}. But
            anyone holding the address can read your list, so treat it like a password and
            replace it if it gets somewhere you didn’t mean.
          </p>
          <Button onClick={() => void create()} loading={busy}>
            Make a link
          </Button>
        </>
      ) : (
        <>
          <CopyField label="Your link" value={link} />
          <p className="text-[12px] leading-snug text-faint">
            Anyone with this address can read your open tasks, so treat it like a password.
            It is read-only and carries nothing but tasks
            {partner ? ` — never the shared work ${partner} has taken on` : ""}.
          </p>

          <Divider />
          <p className="text-[13.5px] leading-relaxed text-muted">
            Paste it into another chat and ask that assistant to read it —{" "}
            <span className="text-ink">
              “read this and tell me what I should do first today”
            </span>
            . It reads live every time, so there is nothing to keep up to date: ask again
            next week and it sees next week’s list.
          </p>

          <Accordion title="What it returns, and other ways to use it">
            <Steps
              items={[
                <>
                  Plain text, grouped the way you think about it: overdue, today, the next
                  seven days, later, and undated — with due dates, priorities, projects,
                  tags and notes.
                </>,
                <>
                  Add <code className="font-mono text-[12px] text-ink">?format=json</code> to
                  the end if something wants structured data rather than prose.
                </>,
                <>
                  Nothing can be created, completed or changed through it — it only ever
                  reads.
                </>,
                <>
                  Opening it in a browser works too, if you just want to glance at the whole
                  list on one page.
                </>,
              ]}
            />
          </Accordion>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" loading={busy} onClick={() => void rotate()}>
              Replace link
            </Button>
            <Button size="sm" variant="danger" loading={busy} onClick={() => void revoke()}>
              Turn off
            </Button>
          </div>
        </>
      )}
    </SettingsCard>
  );
}
