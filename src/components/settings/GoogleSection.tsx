"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { fetcher, googleApi, keys } from "@/lib/api";
import type { GmailScanState, GoogleStatus } from "@/lib/types";
import { relativeTime } from "@/lib/format";
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

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** Turns Google's wording into the actual thing to go and fix. */
function explainGoogleError(message: string): { title: string; fix: string; link?: string } | null {
  const m = message.toLowerCase();
  if (m.includes("has not been used in project") || m.includes("is disabled")) {
    return {
      title: "The Gmail API isn’t switched on in your Google Cloud project",
      fix: "Open the Gmail API page for your project, press Enable, wait a minute, then scan again.",
      link: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
    };
  }
  if (m.includes("insufficient") || m.includes("scope") || m.includes("permission")) {
    return {
      title: "DoneX wasn’t granted permission to read Gmail",
      fix: "Add the gmail.readonly scope under Data access in the Google Auth Platform, then disconnect and reconnect below so the new permission is granted.",
      link: "https://console.cloud.google.com/auth/scopes",
    };
  }
  if (m.includes("expired") || m.includes("invalid_grant")) {
    return {
      title: "The Google connection expired",
      fix: "Reconnect below. Publishing your app (Audience → Publish) stops this recurring every 7 days.",
      link: "https://console.cloud.google.com/auth/audience",
    };
  }
  return null;
}

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
      // Refresh either way so the diagnostics below reflect this attempt.
      void mutateStatus();
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

          <div className="flex flex-wrap gap-1.5">
            <ScopeChip label="Calendar" granted={status.scopes.includes(CALENDAR_SCOPE)} />
            <ScopeChip label="Gmail" granted={status.scopes.includes(GMAIL_SCOPE)} />
          </div>

          {!status.scopes.includes(GMAIL_SCOPE) ? (
            <Notice
              tone="warn"
              title="Gmail permission was never granted"
              body="Google only handed over the permissions listed above. Disconnect and reconnect to grant Gmail access — if the consent screen doesn’t offer it, add the gmail.readonly scope under Data access first."
              link="https://console.cloud.google.com/auth/scopes"
              linkLabel="Google Auth Platform → Data access"
            />
          ) : null}

          <ScanStatus scan={status.gmailScan} enabled={settings.google.gmailScanEnabled} />

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

function ScopeChip({ label, granted }: { label: string; granted: boolean }) {
  return (
    <span
      className={
        granted
          ? "inline-flex items-center gap-1 rounded-full bg-ok/12 px-2.5 py-1 text-[12px] font-medium text-ok"
          : "inline-flex items-center gap-1 rounded-full bg-danger/12 px-2.5 py-1 text-[12px] font-medium text-danger"
      }
    >
      {granted ? "✓" : "✕"} {label}
    </span>
  );
}

function ScanStatus({ scan, enabled }: { scan: GmailScanState; enabled: boolean }) {
  if (!enabled && !scan.error) {
    return (
      <Notice
        tone="warn"
        title="Hourly scanning is off"
        body="Nothing will reach your inbox from Gmail until you turn it on below."
      />
    );
  }
  if (scan.error) {
    const help = explainGoogleError(scan.error);
    return (
      <Notice
        tone="danger"
        title={help?.title ?? "The last Gmail scan failed"}
        body={help?.fix ?? scan.error}
        detail={help ? scan.error : undefined}
        link={help?.link}
        linkLabel="Open Google Cloud"
      />
    );
  }
  if (!scan.at) return null;
  return (
    <p className="text-[13px] text-muted">
      Last scan {relativeTime(scan.at)} ·{" "}
      {scan.created > 0 ? `${scan.created} imported` : "nothing new"}
    </p>
  );
}

function Notice({
  tone,
  title,
  body,
  detail,
  link,
  linkLabel,
}: {
  tone: "warn" | "danger";
  title: string;
  body: string;
  detail?: string;
  link?: string;
  linkLabel?: string;
}) {
  return (
    <div
      className={
        tone === "danger"
          ? "rounded-2xl border border-danger/30 bg-danger/10 p-3.5"
          : "rounded-2xl border border-warn/30 bg-warn/10 p-3.5"
      }
    >
      <p className="text-[14px] font-medium text-ink">{title}</p>
      <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{body}</p>
      {detail ? (
        <p className="mt-1.5 break-words font-mono text-[11.5px] leading-relaxed text-faint">
          {detail}
        </p>
      ) : null}
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-medium text-accent"
        >
          {linkLabel ?? "Open"} <IconExternal className="h-3.5 w-3.5" />
        </a>
      ) : null}
    </div>
  );
}
