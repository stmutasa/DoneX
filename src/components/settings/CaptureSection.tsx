"use client";

import { useEffect, useState } from "react";
import { settingsApi } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Field";
import { useConfirm } from "@/components/ui/Confirm";
import { useToast } from "@/components/ui/Toast";
import {
  Accordion,
  Code,
  CopyField,
  Divider,
  SettingsCard,
  Steps,
  useSettingsPatch,
  type SectionProps,
} from "./common";

export function CaptureSection({ settings, mutate }: SectionProps) {
  const patch = useSettingsPatch(mutate);
  const confirm = useConfirm();
  const toast = useToast();
  const [origin, setOrigin] = useState("");
  const [rotating, setRotating] = useState(false);
  useEffect(() => setOrigin(window.location.origin), []);

  const enabled = settings.smsCaptureEnabled;
  const webhook = origin ? `${origin}/api/ingest/sms` : "…/api/ingest/sms";
  const token = settings.ingestToken || "—";

  const curl = [
    `curl -X POST ${webhook} \\`,
    `  -H "content-type: application/json" \\`,
    `  -H "x-donex-token: ${token}" \\`,
    `  -d '{"from":"Mum","body":"Bring milk home"}'`,
  ].join("\n");

  const rotate = async () => {
    const ok = await confirm({
      title: "Generate a new token?",
      message:
        "Any phone macro using the old token stops working until you paste the new one in.",
      confirmLabel: "Generate",
      destructive: true,
    });
    if (!ok) return;
    setRotating(true);
    try {
      await settingsApi.regenerateIngestToken();
      await mutate();
      toast.success("New token generated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not generate a token");
    } finally {
      setRotating(false);
    }
  };

  return (
    <SettingsCard
      id="capture"
      title="Capture (SMS)"
      description="Forward texts into your inbox from any automation app."
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[15px] text-ink">Accept forwarded texts</div>
          <div className="mt-0.5 text-[13px] text-muted">
            {enabled
              ? "On — texts sent to the webhook land in your inbox."
              : "Off — forwarded texts are rejected and nothing reaches your inbox."}
          </div>
        </div>
        <Switch
          label="Accept forwarded texts"
          checked={enabled}
          onChange={(v) =>
            void patch(
              { smsCaptureEnabled: v },
              v ? "SMS capture on" : "SMS capture off",
            )
          }
        />
      </div>

      {enabled ? (
        <>
          <Divider />
          <CopyField label="Webhook URL" value={webhook} />
          <CopyField label="Ingest token" value={token} />

          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] leading-snug text-faint">
              Treat the token like a password. Generating a new one instantly revokes
              the old — use it if a phone goes missing.
            </p>
            <Button size="sm" loading={rotating} onClick={rotate}>
              New token
            </Button>
          </div>

          <Accordion title="MacroDroid recipe (Android)">
            <Steps
              items={[
                <>Add a new <strong className="text-ink">Macro</strong> and name it “DoneX capture”.</>,
                <>
                  Trigger → <strong className="text-ink">SMS Received</strong> → sender{" "}
                  <strong className="text-ink">Any</strong>.
                </>,
                <>
                  Action → <strong className="text-ink">HTTP Request</strong>. On the{" "}
                  <strong className="text-ink">Settings</strong> tab set method{" "}
                  <strong className="text-ink">POST</strong> — the default is GET, which
                  is rejected.
                </>,
                <>
                  URL: <code className="font-mono text-[12px] text-ink">{webhook}</code>
                </>,
                <>
                  <strong className="text-ink">Header Params</strong> tab: add{" "}
                  <code className="font-mono text-[12px] text-ink">x-donex-token</code> ={" "}
                  <code className="font-mono text-[12px] text-ink">{token}</code>
                </>,
                <>
                  <strong className="text-ink">Content Body</strong> tab: content type{" "}
                  <code className="font-mono text-[12px] text-ink">application/json</code>,
                  body (insert the bracketed parts with the “…” magic-text button):
                  <Code>{`{"from":"[sms_name] [sms_number]","body":"[sms_message]"}`}</Code>
                </>,
                <>Save, then text yourself to check it lands in the DoneX inbox.</>,
              ]}
            />
          </Accordion>

          <Accordion title="Test from a terminal">
            <Code>{curl}</Code>
          </Accordion>
        </>
      ) : (
        <p className="text-[13px] leading-relaxed text-muted">
          Turn this back on whenever you want texts flowing again — your webhook URL and
          token are kept, so an existing phone macro will just start working. To stop the
          texts leaving your phone at all, disable the macro there too.
        </p>
      )}
    </SettingsCard>
  );
}
