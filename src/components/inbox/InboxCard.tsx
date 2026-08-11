"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import type { InboxItem, InboxSource } from "@/lib/types";
import { dueLabel, relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { InboxResolvePayload } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { IconSparkles } from "@/components/ui/icons";

const SOURCE_ICON: Record<InboxSource, string> = {
  sms: "💬",
  gmail: "✉️",
  quick: "⚡",
};

export function InboxCard({
  item,
  onResolve,
  onEdit,
  onSuggest,
  onDismissBecause,
  suggesting,
}: {
  item: InboxItem;
  onResolve: (payload: InboxResolvePayload) => Promise<void>;
  onEdit: (item: InboxItem) => void;
  onSuggest: (item: InboxItem) => void;
  onDismissBecause: (item: InboxItem) => void;
  suggesting?: boolean;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const suggestion = item.suggestion;
  const suggestedTask = suggestion?.action === "task" ? suggestion.task : undefined;

  const run = async (key: string, payload: InboxResolvePayload) => {
    setBusy(key);
    try {
      await onResolve(payload);
    } finally {
      setBusy(null);
    }
  };

  const noteFromItem = () =>
    suggestion?.note ?? { title: "Captured", content: item.content };

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.16 } }}
      transition={{ type: "spring", stiffness: 420, damping: 38 }}
      className="card overflow-hidden p-4"
    >
      <header className="mb-2 flex items-center gap-2">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-2xl bg-sunken text-[15px]">
          {SOURCE_ICON[item.source]}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium text-ink">{item.fromLabel || "Captured"}</p>
          <p className="text-[12px] text-faint">{relativeTime(item.receivedAt)}</p>
        </div>
      </header>

      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="w-full text-left"
        aria-expanded={expanded}
      >
        <p
          className={cn(
            "whitespace-pre-wrap text-[14.5px] leading-relaxed text-muted",
            !expanded && "line-clamp-4",
          )}
        >
          {item.content}
        </p>
      </button>

      {suggestion && suggestion.action !== "ignore" ? (
        <div className="mt-3 rounded-2xl bg-accent-soft p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.08em] text-accent">
            <IconSparkles className="h-3.5 w-3.5" />
            Suggestion
          </div>
          <p className="text-[13.5px] leading-relaxed text-ink">{suggestion.reason}</p>
          {suggestedTask ? (
            <p className="mt-2 text-[14px] font-medium text-ink">
              {suggestedTask.title}
              {suggestedTask.dueAt ? (
                <span className="ml-2 text-[12.5px] font-normal text-accent">
                  {dueLabel(suggestedTask.dueAt, suggestedTask.allDay ?? false)}
                </span>
              ) : null}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {suggestedTask ? (
          <>
            <Button
              size="sm"
              variant="primary"
              loading={busy === "task"}
              onClick={() => run("task", { action: "task", task: suggestedTask })}
            >
              Add task
            </Button>
            <Button size="sm" onClick={() => onEdit(item)}>
              Edit
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="primary"
            loading={busy === "task"}
            onClick={() => run("task", { action: "task", task: { title: item.content.slice(0, 120) } })}
          >
            Make task
          </Button>
        )}

        <Button
          size="sm"
          loading={busy === "note"}
          onClick={() => run("note", { action: "note", note: noteFromItem() })}
        >
          → Note
        </Button>

        {!suggestion ? (
          <Button
            size="sm"
            variant="ghost"
            loading={suggesting}
            icon={<IconSparkles className="h-4 w-4" />}
            onClick={() => onSuggest(item)}
          >
            Suggest
          </Button>
        ) : null}

        <Button
          size="sm"
          variant="ghost"
          loading={busy === "dismiss"}
          onClick={() => run("dismiss", { action: "dismiss" })}
        >
          Dismiss
        </Button>

        <Button size="sm" variant="ghost" onClick={() => onDismissBecause(item)}>
          Dismiss because…
        </Button>
      </div>
    </motion.article>
  );
}
