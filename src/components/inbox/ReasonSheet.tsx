"use client";

import { useEffect, useState } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";

export type ReasonMode = "dismiss" | "restore";

const COPY: Record<ReasonMode, { title: string; prompt: string; cta: string; hint: string }> = {
  dismiss: {
    title: "Dismiss because…",
    prompt: "Why doesn’t this belong here? Your words become a rule the triage follows.",
    cta: "Dismiss & teach",
    hint: "e.g. “I never act on LinkedIn invites” or “school newsletters go straight to my wife”",
  },
  restore: {
    title: "Bring it back & teach",
    prompt:
      "Why should this have stayed? It returns to your inbox, and triage learns not to repeat the mistake.",
    cta: "Restore & teach",
    hint: "e.g. “anything from my kid’s school matters” — leave empty to just restore it",
  },
};

export function ReasonSheet({
  mode,
  open,
  itemPreview,
  onClose,
  onSubmit,
}: {
  mode: ReasonMode;
  open: boolean;
  itemPreview: string;
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const copy = COPY[mode];

  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const submit = async () => {
    if (mode === "dismiss" && !reason.trim()) return;
    setBusy(true);
    try {
      await onSubmit(reason.trim());
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={copy.title}
      footer={
        <div className="flex gap-2">
          <Button block onClick={onClose}>
            Cancel
          </Button>
          <Button
            block
            variant="primary"
            loading={busy}
            disabled={mode === "dismiss" && !reason.trim()}
            onClick={submit}
          >
            {mode === "restore" && !reason.trim() ? "Just restore" : copy.cta}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 pt-1">
        <p className="line-clamp-2 rounded-xl bg-sunken px-3 py-2 text-[13px] text-muted">
          {itemPreview}
        </p>
        <p className="text-[14px] leading-relaxed text-ink">{copy.prompt}</p>
        <Textarea
          value={reason}
          autoFocus
          rows={3}
          placeholder={copy.hint}
          maxLength={240}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
    </Sheet>
  );
}
