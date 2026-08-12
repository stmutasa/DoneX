"use client";

import { useEffect, useState } from "react";
import { pushApi } from "@/lib/api";
import { WEEKDAY_NAMES } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Select, SwitchRow } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { SettingsCard, Divider, useSettingsPatch, type SectionProps } from "./common";

function urlBase64ToUint8Array(base64: string) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(normalized);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;
  try {
    return await navigator.serviceWorker.register("/sw.js");
  } catch {
    return null;
  }
}

export function NotificationsSection({ settings, mutate }: SectionProps) {
  const patch = useSettingsPatch(mutate);
  const toast = useToast();
  const n = settings.notifications;

  const [supported, setSupported] = useState(true);
  const [subscribed, setSubscribed] = useState(false);
  const [working, setWorking] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    const ok =
      typeof window !== "undefined" &&
      "Notification" in window &&
      "serviceWorker" in navigator &&
      "PushManager" in window;
    setSupported(ok);
    if (!ok) return;
    void (async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setSubscribed(!!sub && Notification.permission === "granted");
    })();
  }, []);

  const enable = async () => {
    setWorking(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toast.error("Notifications are blocked for this site.");
        return;
      }
      const reg = await getRegistration();
      if (!reg) {
        toast.error("Service worker unavailable — try after a reload.");
        return;
      }
      const { publicKey } = await pushApi.vapid();
      const existing = await reg.pushManager.getSubscription();
      const sub =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        }));
      await pushApi.subscribe(sub.toJSON());
      setSubscribed(true);
      toast.success("Notifications on");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not enable notifications");
    } finally {
      setWorking(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      await pushApi.test();
      toast.success("Test notification sent");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send a test");
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsCard
      id="notifications"
      title="Notifications"
      description="Nudges for reminders, your morning briefing, and the weekly review."
    >
      {!supported ? (
        <p className="rounded-2xl border border-stroke bg-sunken p-3 text-[13.5px] leading-relaxed text-muted">
          Push isn’t available in this browser. On iPhone, install DoneX to your Home Screen first
          (Share → Add to Home Screen), then open it from there.
        </p>
      ) : !subscribed ? (
        <div className="space-y-2">
          <Button variant="primary" loading={working} onClick={enable}>
            Enable notifications
          </Button>
          <p className="text-[12.5px] leading-relaxed text-faint">
            On iPhone, install to Home Screen first (Share → Add to Home Screen).
          </p>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-ok/12 px-3 py-1.5 text-[13px] font-medium text-ok">
            Enabled on this device
          </span>
          <Button size="sm" loading={testing} onClick={sendTest}>
            Send test
          </Button>
        </div>
      )}

      <Divider />

      <SwitchRow
        label="Task reminders"
        description="A ping when something is due."
        checked={n.remindersEnabled}
        onChange={(v) => void patch({ notifications: { remindersEnabled: v } })}
      />

      <SwitchRow
        label="Morning briefing"
        checked={n.briefingEnabled}
        onChange={(v) => void patch({ notifications: { briefingEnabled: v } })}
      />
      {n.briefingEnabled ? (
        <div className="flex items-center justify-between gap-3 pl-1">
          <span className="text-[13.5px] text-muted">Briefing time</span>
          <input
            type="time"
            value={n.briefingTime}
            aria-label="Briefing time"
            onChange={(e) => void patch({ notifications: { briefingTime: e.target.value } })}
            className="h-11 w-[128px] rounded-xl border border-stroke bg-sunken px-3 text-[15px] text-ink outline-none"
          />
        </div>
      ) : null}

      <SwitchRow
        label="Bedtime"
        description="No email checking (or the pings that come with it) between these hours."
        checked={n.quietHoursEnabled}
        onChange={(v) => void patch({ notifications: { quietHoursEnabled: v } })}
      />
      {n.quietHoursEnabled ? (
        <div className="flex items-center gap-3 pl-1">
          <div className="flex-1">
            <div className="mb-1.5 text-[13px] font-medium text-muted">From</div>
            <input
              type="time"
              value={n.quietStart}
              aria-label="Bedtime start"
              onChange={(e) => void patch({ notifications: { quietStart: e.target.value } })}
              className="h-11 w-full rounded-xl border border-stroke bg-sunken px-3 text-[15px] text-ink outline-none"
            />
          </div>
          <div className="flex-1">
            <div className="mb-1.5 text-[13px] font-medium text-muted">Until</div>
            <input
              type="time"
              value={n.quietEnd}
              aria-label="Bedtime end"
              onChange={(e) => void patch({ notifications: { quietEnd: e.target.value } })}
              className="h-11 w-full rounded-xl border border-stroke bg-sunken px-3 text-[15px] text-ink outline-none"
            />
          </div>
        </div>
      ) : null}

      <SwitchRow
        label="Weekly review"
        checked={n.weeklyReviewEnabled}
        onChange={(v) => void patch({ notifications: { weeklyReviewEnabled: v } })}
      />
      {n.weeklyReviewEnabled ? (
        <div className="flex items-end gap-2 pl-1">
          <Select
            label="Day"
            value={String(n.weeklyDay)}
            onChange={(e) => void patch({ notifications: { weeklyDay: Number(e.target.value) } })}
          >
            {WEEKDAY_NAMES.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </Select>
          <div className="w-[128px] shrink-0">
            <div className="mb-1.5 text-[13px] font-medium text-muted">Time</div>
            <input
              type="time"
              value={n.weeklyTime}
              aria-label="Weekly review time"
              onChange={(e) => void patch({ notifications: { weeklyTime: e.target.value } })}
              className="h-11 w-full rounded-xl border border-stroke bg-sunken px-3 text-[15px] text-ink outline-none"
            />
          </div>
        </div>
      ) : null}
    </SettingsCard>
  );
}
