"use client";

import { useEffect, useState } from "react";
import { Accordion, Code, CopyField, SettingsCard, Steps, type SectionProps } from "./common";

export function CaptureSection({ settings }: Pick<SectionProps, "settings">) {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);

  const webhook = origin ? `${origin}/api/ingest/sms` : "…/api/ingest/sms";
  const token = settings.ingestToken || "—";

  const curl = [
    `curl -X POST ${webhook} \\`,
    `  -H "content-type: application/json" \\`,
    `  -H "x-donex-token: ${token}" \\`,
    `  -d '{"from":"Mum","body":"Bring milk home"}'`,
  ].join("\n");

  return (
    <SettingsCard
      id="capture"
      title="Capture (SMS)"
      description="Forward texts into your inbox from any automation app."
    >
      <CopyField label="Webhook URL" value={webhook} />
      <CopyField label="Ingest token" value={token} />

      <Accordion title="MacroDroid recipe (Android)">
        <Steps
          items={[
            <>Add a new <strong className="text-ink">Macro</strong> and name it “DoneX capture”.</>,
            <>
              Trigger → <strong className="text-ink">SMS Received</strong> → sender{" "}
              <strong className="text-ink">Any</strong>.
            </>,
            <>
              Action → <strong className="text-ink">HTTP Request</strong> → method{" "}
              <strong className="text-ink">POST</strong>.
            </>,
            <>
              URL: <code className="font-mono text-[12px] text-ink">{webhook}</code>
            </>,
            <>
              Content type <code className="font-mono text-[12px] text-ink">application/json</code>,
              and add header{" "}
              <code className="font-mono text-[12px] text-ink">x-donex-token: {token}</code>
            </>,
            <>
              Body (magic text):
              <Code>{`{"from":"[sms_name]","body":"[sms_message]"}`}</Code>
            </>,
            <>Save, then text yourself to check it lands in the DoneX inbox.</>,
          ]}
        />
      </Accordion>

      <Accordion title="Test from a terminal">
        <Code>{curl}</Code>
      </Accordion>
    </SettingsCard>
  );
}
