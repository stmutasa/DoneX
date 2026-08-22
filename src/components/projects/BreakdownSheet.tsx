"use client";

import { useEffect, useRef, useState } from "react";
import { useSWRConfig } from "swr";
import { ApiError, matchKey, projectsApi, tasksApi } from "@/lib/api";
import type { TaskDraft } from "@/lib/types";
import { PRIORITY_META } from "@/lib/types";
import { deadlineChip, dueLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAutoGrow } from "@/hooks/useAutoGrow";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { IconCheck, IconFlag, IconSparkles } from "@/components/ui/icons";

interface Proposal {
  draft: TaskDraft;
  keep: boolean;
}

/**
 * Paste a paragraph → the AI splits it into separate tasks for this project.
 * Nothing is created until the user reviews the proposals and taps Add.
 */
export function BreakdownSheet({
  open,
  onClose,
  projectId,
  projectName,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
}) {
  const toast = useToast();
  const { mutate } = useSWRConfig();
  const [text, setText] = useState("");
  const [generating, setGenerating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [needsAi, setNeedsAi] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useAutoGrow(textRef, text, 320);

  useEffect(() => {
    if (!open) return;
    setText("");
    setProposals(null);
    setGenerating(false);
    setAdding(false);
    setNeedsAi(false);
  }, [open]);

  const generate = async () => {
    const value = text.trim();
    if (!value) return;
    setGenerating(true);
    setNeedsAi(false);
    try {
      const { drafts } = await projectsApi.breakdown(projectId, value);
      if (drafts.length === 0) {
        toast.error("Couldn’t find anything actionable in that text");
        setProposals(null);
      } else {
        setProposals(drafts.map((draft) => ({ draft, keep: true })));
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setNeedsAi(true);
      else toast.error(err instanceof Error ? err.message : "Could not break that down");
    } finally {
      setGenerating(false);
    }
  };

  const kept = proposals?.filter((p) => p.keep) ?? [];

  const addAll = async () => {
    if (kept.length === 0) return;
    setAdding(true);
    let added = 0;
    try {
      // Through the normal task API one by one, in paragraph order — so
      // validation, dueKind handling and the offline outbox all apply.
      for (const p of kept) {
        try {
          await tasksApi.create(p.draft);
          added += 1;
        } catch (err) {
          toast.error(
            err instanceof Error ? `“${p.draft.title}”: ${err.message}` : "One task failed",
          );
        }
      }
      if (added > 0) {
        void mutate(matchKey("/api/tasks", "/api/stats", "/api/tags", "/api/projects"));
        toast.success(`Added ${added} task${added === 1 ? "" : "s"} to ${projectName}`);
        onClose();
      }
    } finally {
      setAdding(false);
    }
  };

  const toggle = (index: number) =>
    setProposals((prev) =>
      prev ? prev.map((p, i) => (i === index ? { ...p, keep: !p.keep } : p)) : prev,
    );

  const chips = (draft: TaskDraft): string[] => {
    const out: string[] = [];
    if (draft.dueAt) {
      out.push(draft.dueKind === "by" ? deadlineChip(draft.dueAt) : dueLabel(draft.dueAt, draft.allDay ?? false));
    }
    if (draft.priority) out.push(PRIORITY_META[draft.priority].short);
    for (const t of draft.tags ?? []) out.push(`#${t}`);
    return out;
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="lg"
      title="Paste text → tasks"
      footer={
        proposals ? (
          <div className="flex gap-2">
            <Button block onClick={() => setProposals(null)} disabled={adding}>
              Edit text
            </Button>
            <Button block variant="primary" loading={adding} disabled={kept.length === 0} onClick={addAll}>
              Add {kept.length} task{kept.length === 1 ? "" : "s"}
            </Button>
          </div>
        ) : (
          <Button
            block
            variant="primary"
            loading={generating}
            disabled={!text.trim()}
            onClick={generate}
            icon={<IconSparkles className="h-4 w-4" />}
          >
            {generating ? "Reading it…" : "Break into tasks"}
          </Button>
        )
      }
    >
      {needsAi ? (
        <p className="mb-3 rounded-2xl border border-stroke bg-sunken px-3.5 py-3 text-[13px] leading-relaxed text-muted">
          This needs an AI model — add a provider key in Settings → AI model first.
        </p>
      ) : null}

      {proposals === null ? (
        <div className="space-y-2 pt-1">
          <textarea
            ref={textRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            maxLength={4000}
            autoFocus
            placeholder={`Dump the whole thing in — an email, meeting notes, a rambling voice-memo transcript…\n\n“Before the trip we need to renew Maya’s passport by the 15th, book the airport parking, and I should call the bank about the card. Also pack meds!”`}
            className="w-full resize-none rounded-2xl border border-stroke bg-sunken p-3.5 text-[15px] leading-relaxed text-ink outline-none placeholder:text-faint focus:border-accent"
          />
          <p className="px-1 text-[12px] text-faint">
            The AI splits it into separate tasks for {projectName} — you review the list before
            anything is added.
          </p>
        </div>
      ) : (
        <div className="space-y-1.5 pt-1">
          <p className="px-1 pb-1 text-[13px] text-muted">
            Found {proposals.length} task{proposals.length === 1 ? "" : "s"} — untick any you
            don’t want.
          </p>
          {proposals.map((p, i) => (
            <button
              key={`${p.draft.title}-${i}`}
              type="button"
              onClick={() => toggle(i)}
              className={cn(
                "flex w-full items-start gap-3 rounded-2xl border px-3 py-2.5 text-left transition-colors",
                p.keep ? "border-stroke bg-elev" : "border-stroke bg-sunken opacity-55",
              )}
            >
              <span
                className={cn(
                  "mt-0.5 grid h-[22px] w-[22px] shrink-0 place-items-center rounded-lg border-2 transition-colors",
                  p.keep
                    ? "border-transparent bg-sunrise text-on-accent"
                    : "border-stroke-strong text-transparent",
                )}
              >
                <IconCheck className="h-3 w-3" strokeWidth={3} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[14.5px] leading-snug text-ink">{p.draft.title}</span>
                {p.draft.notes ? (
                  <span className="mt-0.5 block text-[12.5px] leading-snug text-muted">
                    {p.draft.notes}
                  </span>
                ) : null}
                {chips(p.draft).length ? (
                  <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-muted">
                    {chips(p.draft).map((c) => (
                      <span key={c} className="inline-flex items-center gap-0.5">
                        {c.startsWith("P") ? <IconFlag className="h-3 w-3" /> : null}
                        {c}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}
