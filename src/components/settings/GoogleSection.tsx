"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { fetcher, googleApi, keys } from "@/lib/api";
import type { GoogleStatus } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Input, SwitchRow } from "@/components/ui/Field";
import { useConfirm } from "@/components/ui/Confirm";
import { useToast } from "@/components/ui/Toast";
import { IconExternal } from "@/components/ui/icons";
import {
  Accordion,
  CopyField,
  Divider,
  SettingsCard,
  Steps,
  maskPlaceholder,
  useSettingsPatch,
  type SectionProps,
} from "./common";

export function GoogleSection({ settings, mutate }: SectionProps) {
  const patch = useSettingsPatch(mutate);
  const toast = useToast();
  const confirm = useConfirm();
  const { data: status, mutate: mutateStatus } = useSWR<GoogleStatus>(keys.googleStatus(), fetcher);

  const [clientId, setClientId] = useState(settings.google.clientId);
  const [secretDraft, setSecretDraft] = useState("");
  const [origin, setOrigin] = useState("");
  const [scanning, setScanning] = useState(false);

  useEffect(() => setOrigin(window.location.origin), []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get("google");
    if (!flag) return;
    if (flag === "connected") toast.success("Google connected");
    else toast.error("Google connection failed — check your client id and secret.");
    void mutateStatus();
    params.delete("google");
    const q = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${q ? `?${q}` : ""}${window.location.hash}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scan = async () => {
    setScanning(true);
    try {
      const { created } = await googleApi.scan();
      toast.success(created ? `${created} imported to your inbox` : "Nothing new to import");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Gmail scan failed");
    } finally {
      setScanning(false);
    }
  };

  const disconnect = async () => {
    const ok = await confirm({
      title: "Disconnect Google?",
      message: "Calendar and Gmail features will stop until you reconnect.",
      confirmLabel: "Disconnect",
      destructive: true,
    });
    if (!ok) return;
    try {
      await googleApi.disconnect();
      await mutateStatus();
      toast.success("Google disconnected");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not disconnect");
    }
  };

  const redirectUri = origin ? `${origin}/api/google/callback` : "…/api/google/callback";

  return (
    <SettingsCard
      id="google"
      title="Google"
      description="Pull in today’s calendar and let Gmail feed your inbox."
    >
      <Accordion title="Set up Google credentials" defaultOpen={!status?.configured}>
        <Steps
          items={[
            <>Open the Google Cloud console and create (or pick) a project.</>,
            <>Enable the <strong className="text-ink">Google Calendar API</strong> and <strong className="text-ink">Gmail API</strong>.</>,
            <>Configure the OAuth consent screen as <strong className="text-ink">External</strong>, then add yourself as a test user.</>,
            <>Create an OAuth client ID of type <strong className="text-ink">Web application</strong>.</>,
            <>Paste the redirect URI below into <strong className="text-ink">Authorised redirect URIs</strong>.</>,
            <>Copy the client id and secret into the fields below and hit Connect.</>,
          ]}
        />
        <CopyField label="Redirect URI" value={redirectUri} />
        <a
          href="https://console.cloud.google.com/apis/credentials"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-accent"
        >
          Google Cloud credentials <IconExternal className="h-3.5 w-3.5" />
        </a>
      </Accordion>

      <Input
        label="Client ID"
        value={clientId}
        placeholder="1234-abc.apps.googleusercontent.com"
        onChange={(e) => setClientId(e.target.value)}
        onBlur={() => clientId !== settings.google.clientId && patch({ google: { clientId } })}
      />

      <div>
        <Input
          label="Client secret"
          hint={settings.google.clientSecret.set ? "Saved" : undefined}
          type="password"
          autoComplete="off"
          value={secretDraft}
          placeholder={maskPlaceholder(settings.google.clientSecret, "GOCSPX-…")}
          onChange={(e) => setSecretDraft(e.target.value)}
        />
        {secretDraft.trim() ? (
          <Button
            size="sm"
            variant="primary"
            className="mt-2"
            onClick={async () => {
              const ok = await patch({ google: { clientSecret: secretDraft.trim() } }, "Secret saved");
              if (ok) setSecretDraft("");
            }}
          >
            Save secret
          </Button>
        ) : null}
      </div>

      <Divider />

      {status?.connected ? (
        <div className="space-y-3">
          <p className="text-[14px] text-ink">
            Connected as <span className="font-medium">{status.email ?? "your account"}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" loading={scanning} onClick={scan}>
              Scan Gmail now
            </Button>
            <Button size="sm" variant="ghost" onClick={disconnect}>
              Disconnect
            </Button>
          </div>
          <SwitchRow
            label="Scan Gmail hourly"
            description="Unread primary mail becomes inbox items."
            checked={settings.google.gmailScanEnabled}
            onChange={(v) => void patch({ google: { gmailScanEnabled: v } })}
          />
        </div>
      ) : (
        <Button
          variant="primary"
          disabled={!status?.configured}
          onClick={() => {
            window.location.href = "/api/google/connect";
          }}
        >
          {status?.configured ? "Connect Google" : "Add credentials first"}
        </Button>
      )}
    </SettingsCard>
  );
}
