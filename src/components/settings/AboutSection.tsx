"use client";

import { useEffect, useState } from "react";
import { format } from "date-fns";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { APP_VERSION, BUILD_ID, applyUpdate, buildTime, fetchServerBuildId } from "@/lib/version";
import { SettingsCard, Divider } from "./common";

export function AboutSection() {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [serverBuild, setServerBuild] = useState<string | null>(null);
  const [liveSince, setLiveSince] = useState<string>("");

  // Formatted after mount: the build stamp is UTC and renders in local time,
  // which the server can't know.
  useEffect(() => {
    const t = buildTime();
    setLiveSince(t ? format(t, "d MMM yyyy, h:mm a") : "");
  }, []);

  const outdated = !!serverBuild && serverBuild !== "dev" && serverBuild !== BUILD_ID;

  const check = async () => {
    setChecking(true);
    const server = await fetchServerBuildId();
    setServerBuild(server);
    setChecking(false);
    if (!server) toast.error("Couldn’t reach the server — try again in a moment.");
    else if (server === BUILD_ID) toast.success("You’re on the latest version");
  };

  return (
    <SettingsCard id="about" title="About" description="What you’re running right now.">
      <Row label="Version" value={`DoneX ${APP_VERSION}`} />
      <Row label="Build" value={BUILD_ID} mono />
      {liveSince ? <Row label="Live since" value={liveSince} /> : null}

      <Divider />

      {outdated ? (
        <div className="rounded-2xl border border-accent/40 bg-accent-soft p-3.5">
          <p className="text-[14px] font-medium text-ink">A newer version is available</p>
          <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
            The server is running <span className="font-mono text-[12px]">{serverBuild}</span>.
            Refreshing clears the cached app and loads it.
          </p>
          <Button size="sm" variant="primary" className="mt-2.5" onClick={() => void applyUpdate()}>
            Refresh now
          </Button>
        </div>
      ) : (
        <Button size="sm" loading={checking} onClick={check}>
          Check for updates
        </Button>
      )}
    </SettingsCard>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[14px] text-muted">{label}</span>
      <span className={mono ? "font-mono text-[12.5px] text-ink" : "text-[14px] text-ink"}>
        {value}
      </span>
    </div>
  );
}
