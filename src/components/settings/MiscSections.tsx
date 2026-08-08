"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { authApi, dataApi } from "@/lib/api";
import { useInstallPrompt } from "@/hooks/useInstallPrompt";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { useConfirm } from "@/components/ui/Confirm";
import { useToast } from "@/components/ui/Toast";
import {
  IconDownload,
  IconLogout,
  IconMonitor,
  IconMoon,
  IconSun,
  IconUpload,
} from "@/components/ui/icons";
import { useTheme } from "@/components/shell/ThemeProvider";
import { SettingsCard, Divider, useSettingsPatch, type SectionProps } from "./common";

export function ProfileSection({ settings, mutate }: SectionProps) {
  const patch = useSettingsPatch(mutate);
  const router = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const [detected, setDetected] = useState("");

  useEffect(() => {
    try {
      setDetected(Intl.DateTimeFormat().resolvedOptions().timeZone || "");
    } catch {
      setDetected("");
    }
  }, []);

  const mismatch = !!detected && detected !== settings.tz;

  const signOut = async () => {
    const ok = await confirm({
      title: "Sign out?",
      message: "You’ll need your PIN to get back in.",
      confirmLabel: "Sign out",
    });
    if (!ok) return;
    try {
      await authApi.logout();
      router.push("/login");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not sign out");
    }
  };

  return (
    <SettingsCard id="profile" title="Profile & security">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[15px] text-ink">Time zone</div>
          <div className="mt-0.5 truncate text-[13px] text-muted">{settings.tz}</div>
        </div>
        {mismatch ? (
          <Button size="sm" variant="primary" onClick={() => patch({ tz: detected }, "Time zone updated")}>
            Use {detected}
          </Button>
        ) : null}
      </div>

      <Divider />

      <Button variant="danger" icon={<IconLogout className="h-4 w-4" />} onClick={signOut}>
        Sign out
      </Button>
    </SettingsCard>
  );
}

export function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const install = useInstallPrompt();

  return (
    <SettingsCard id="appearance" title="Appearance">
      <Segmented
        ariaLabel="Theme"
        value={theme}
        onChange={setTheme}
        options={[
          { value: "system", label: "System", icon: <IconMonitor className="h-4 w-4" /> },
          { value: "light", label: "Light", icon: <IconSun className="h-4 w-4" /> },
          { value: "dark", label: "Dark", icon: <IconMoon className="h-4 w-4" /> },
        ]}
      />
      {install.available ? (
        <>
          <Divider />
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[15px] text-ink">Install app</div>
              <div className="mt-0.5 text-[13px] text-muted">Runs full-screen, works offline.</div>
            </div>
            <Button size="sm" variant="primary" onClick={() => void install.promptInstall()}>
              Install
            </Button>
          </div>
        </>
      ) : null}
    </SettingsCard>
  );
}

export function DataSection() {
  const toast = useToast();
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const ok = await confirm({
      title: "Import this backup?",
      message: "Existing items with the same ids will be overwritten.",
      confirmLabel: "Import",
    });
    if (!ok) return;
    setImporting(true);
    try {
      const text = await file.text();
      const { imported } = await dataApi.import(text);
      toast.success(`Imported ${imported} items`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <SettingsCard id="data" title="Data" description="Everything you’ve captured, portable.">
      <div className="flex flex-wrap gap-2">
        <a
          href={dataApi.exportUrl}
          download
          className="inline-flex min-h-[44px] items-center gap-2 rounded-2xl border border-stroke bg-elev px-4 text-sm font-medium text-ink transition-colors hover:border-stroke-strong"
        >
          <IconDownload className="h-4 w-4 text-accent" />
          Export JSON
        </a>
        <Button
          loading={importing}
          icon={<IconUpload className="h-4 w-4 text-accent" />}
          onClick={() => fileRef.current?.click()}
        >
          Import
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </div>
      <p className="text-[12px] text-faint">DoneX v1</p>
    </SettingsCard>
  );
}
