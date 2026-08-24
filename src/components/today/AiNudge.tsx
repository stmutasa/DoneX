"use client";

import Link from "next/link";
import { IconSparkles, IconX } from "@/components/ui/icons";
import { IconButton } from "@/components/ui/Button";

export function AiNudge({ onDismiss, what = "briefing" }: { onDismiss?: () => void; what?: string }) {
  return (
    <div className="card flex items-start gap-3 p-4">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
        <IconSparkles className="h-[18px] w-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium text-ink">Connect an AI model</p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-muted">
          Add a provider key and DoneX can write your {what}, plan your day, and chat with you.
        </p>
        <Link
          href="/settings/ai"
          className="mt-2.5 inline-flex min-h-[36px] items-center rounded-xl bg-sunrise px-3 text-[13px] font-medium text-on-accent"
        >
          Open AI settings
        </Link>
      </div>
      {onDismiss ? (
        <IconButton label="Dismiss" size="sm" onClick={onDismiss}>
          <IconX className="h-4 w-4" />
        </IconButton>
      ) : null}
    </div>
  );
}
