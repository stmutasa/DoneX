"use client";

import { useMemo, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { AnimatePresence, motion } from "framer-motion";
import { ApiError, fetcher, inboxApi, keys, matchKey, type InboxResolvePayload } from "@/lib/api";
import type { InboxItem, TaskDraft } from "@/lib/types";
import { relativeTime } from "@/lib/format";
import { Page } from "@/components/shell/Page";
import { Button } from "@/components/ui/Button";
import { EmptyState, PageHeader, SkeletonRows } from "@/components/ui/Misc";
import { useToast } from "@/components/ui/Toast";
import { IconChevronDown, IconPlus, IconRefresh, IconSparkles } from "@/components/ui/icons";
import { InboxCard } from "@/components/inbox/InboxCard";
import { ReasonSheet, type ReasonMode } from "@/components/inbox/ReasonSheet";
import { TaskEditor } from "@/components/tasks/TaskEditor";

export default function InboxPage() {
  const toast = useToast();
  const { mutate: globalMutate } = useSWRConfig();

  const { data, error, isLoading, mutate } = useSWR<{ items: InboxItem[]; newCount: number }>(
    keys.inbox("all"),
    fetcher,
  );

  const [capture, setCapture] = useState("");
  const [capturing, setCapturing] = useState(false);
  // Enter can fire again before the re-render that marks us capturing.
  const capturingRef = useRef(false);
  const [triaging, setTriaging] = useState(false);
  const [suggestingId, setSuggestingId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<InboxItem | null>(null);
  const [reasonTarget, setReasonTarget] = useState<{ item: InboxItem; mode: ReasonMode } | null>(
    null,
  );

  const items = data?.items ?? [];
  const fresh = useMemo(() => items.filter((i) => i.status === "new"), [items]);
  const history = useMemo(() => items.filter((i) => i.status !== "new"), [items]);

  const refreshAll = async () => {
    await mutate();
    void globalMutate(matchKey("/api/inbox", "/api/tasks", "/api/notes", "/api/stats"));
  };

  const submitCapture = async () => {
    const content = capture.trim();
    if (!content || capturingRef.current) return;
    capturingRef.current = true;
    setCapturing(true);
    try {
      await inboxApi.capture(content);
      setCapture("");
      await refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not capture that");
    } finally {
      capturingRef.current = false;
      setCapturing(false);
    }
  };

  /** True once the item has left the inbox (including when something else
   *  already handled it); false when it failed and is still waiting. */
  const resolve = async (item: InboxItem, payload: InboxResolvePayload): Promise<boolean> => {
    try {
      await inboxApi.resolve(item.id, payload);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not resolve that");
      if (err instanceof ApiError && err.status === 409) {
        // Already handled elsewhere: drop the stale card.
        await refreshAll();
        return true;
      }
      return false;
    }
    toast.success(
      payload.action === "task"
        ? "Added to your tasks"
        : payload.action === "note"
          ? "Saved to notes"
          : "Dismissed",
    );
    await refreshAll();
    return true;
  };

  const suggest = async (item: InboxItem) => {
    setSuggestingId(item.id);
    try {
      const { items: results } = await inboxApi.triage(item.id);
      await refreshAll();
      const result = results[0];
      if (result?.suggestion?.updatedTaskTitle) {
        toast.success(result.suggestion.reason || `Updated “${result.suggestion.updatedTaskTitle}”`);
      } else if (result && result.status === "dismissed") {
        toast.success(
          result.suggestion?.duplicateOfTitle
            ? `Dismissed — already tracked: ${result.suggestion.duplicateOfTitle}`
            : "Dismissed — nothing to do here",
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not get a suggestion");
    } finally {
      setSuggestingId(null);
    }
  };

  const triageAll = async () => {
    setTriaging(true);
    try {
      const { kept, dismissed, updated, failed, failure } = await inboxApi.triage();
      await refreshAll();
      const parts: string[] = [];
      if (typeof kept === "number" && kept > 0) parts.push(`${kept} for you to review`);
      if (typeof updated === "number" && updated > 0)
        parts.push(`${updated} task${updated === 1 ? "" : "s"} updated`);
      if (typeof dismissed === "number" && dismissed > 0) parts.push(`${dismissed} auto-dismissed`);
      if (parts.length || !failed) toast.success(parts.length ? parts.join(" · ") : "Nothing needed triaging");
      if (typeof failed === "number" && failed > 0) {
        toast.error(`${failed} couldn't be triaged${failure ? `: ${failure}` : ""}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not triage");
    } finally {
      setTriaging(false);
    }
  };

  const submitEdited = async (draft: TaskDraft) => {
    if (!editingItem) return;
    // Throwing keeps the editor open with your changes, ready to retry.
    if (!(await resolve(editingItem, { action: "task", task: draft }))) {
      throw new Error("Could not add the task");
    }
    setEditingItem(null);
  };

  const submitReason = async (reason: string) => {
    if (!reasonTarget) return;
    const { item, mode } = reasonTarget;
    try {
      if (mode === "dismiss") {
        await inboxApi.resolve(item.id, { action: "dismiss", reason });
        toast.success("Dismissed — triage will remember that");
      } else {
        const { learned } = await inboxApi.restore(item.id, reason || undefined);
        toast.success(
          learned ? "Restored — triage will remember that" : "Restored to your inbox",
        );
      }
      await refreshAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save that");
      // Already handled elsewhere: nothing left to dismiss, so let the sheet close.
      if (mode === "dismiss" && err instanceof ApiError && err.status === 409) {
        await refreshAll();
        return;
      }
      throw err;
    }
  };

  return (
    <Page>
      <PageHeader
        title="Inbox"
        subtitle="Everything that landed, waiting to become something."
        actions={
          fresh.length > 1 ? (
            <Button
              size="sm"
              icon={<IconSparkles className="h-4 w-4 text-accent" />}
              loading={triaging}
              onClick={triageAll}
            >
              Triage all
            </Button>
          ) : null
        }
      />

      <div className="mb-5 flex gap-2">
        <input
          value={capture}
          onChange={(e) => setCapture(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submitCapture();
            }
          }}
          placeholder="Drop a thought…"
          aria-label="Capture a thought"
          className="h-12 min-w-0 flex-1 rounded-2xl border border-stroke bg-elev px-4 text-[15px] text-ink outline-none placeholder:text-faint focus:border-stroke-strong"
        />
        <Button
          variant="primary"
          loading={capturing}
          disabled={!capture.trim()}
          onClick={submitCapture}
          aria-label="Capture"
        >
          <IconPlus className="h-5 w-5" />
        </Button>
      </div>

      {isLoading ? (
        <SkeletonRows rows={3} />
      ) : error && !data ? (
        <EmptyState
          emoji="📡"
          title="Could not load your inbox"
          message="Check your connection and try again."
          action={
            <Button icon={<IconRefresh className="h-4 w-4" />} onClick={() => void mutate()}>
              Try again
            </Button>
          }
        />
      ) : fresh.length === 0 ? (
        <EmptyState emoji="🍃" title="Inbox zero. Breathe." message="Nothing waiting on you here." />
      ) : (
        <div className="space-y-3">
          <AnimatePresence initial={false}>
            {fresh.map((item) => (
              <InboxCard
                key={item.id}
                item={item}
                suggesting={suggestingId === item.id}
                onResolve={(payload) => resolve(item, payload)}
                onEdit={setEditingItem}
                onSuggest={suggest}
                onDismissBecause={(target) => setReasonTarget({ item: target, mode: "dismiss" })}
              />
            ))}
          </AnimatePresence>
        </div>
      )}

      {history.length ? (
        <section className="mt-8">
          <button
            type="button"
            onClick={() => setHistoryOpen((h) => !h)}
            aria-expanded={historyOpen}
            className="flex min-h-[44px] w-full items-center gap-2 rounded-2xl border border-stroke bg-elev px-4 text-left"
          >
            <span className="flex-1 text-[14px] text-muted">History · {history.length}</span>
            <IconChevronDown
              className={`h-4 w-4 text-faint transition-transform ${historyOpen ? "" : "-rotate-90"}`}
            />
          </button>

          <AnimatePresence initial={false}>
            {historyOpen ? (
              <motion.ul
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                className="overflow-hidden"
              >
                {history.map((item) => (
                  <li
                    key={item.id}
                    className="mt-2 flex items-start gap-2.5 rounded-2xl border border-stroke bg-elev/60 px-3.5 py-3"
                  >
                    <span className="mt-0.5 text-[13px]">
                      {item.status === "resolved" ? "✅" : "🗑️"}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 block text-[13.5px] text-muted">
                        {item.content}
                      </span>
                      <span className="mt-0.5 block text-[12px] text-faint">
                        {item.fromLabel} · {relativeTime(item.receivedAt)}
                        {item.suggestion?.updatedTaskTitle
                          ? ` · AI: ${item.suggestion.reason || `updated — ${item.suggestion.updatedTaskTitle}`}`
                          : item.suggestion?.autoDismissed
                            ? ` · AI: ${
                                item.suggestion.duplicateOfTitle
                                  ? `already tracked — ${item.suggestion.duplicateOfTitle}`
                                  : item.suggestion.reason || "nothing actionable"
                              }`
                            : ""}
                      </span>
                    </span>
                    {item.status === "dismissed" ? (
                      <button
                        type="button"
                        onClick={() => setReasonTarget({ item, mode: "restore" })}
                        className="shrink-0 self-center rounded-full px-2.5 py-1.5 text-[12px] font-medium text-accent transition-colors hover:bg-accent-soft"
                      >
                        Restore…
                      </button>
                    ) : null}
                  </li>
                ))}
              </motion.ul>
            ) : null}
          </AnimatePresence>
        </section>
      ) : null}

      <ReasonSheet
        mode={reasonTarget?.mode ?? "dismiss"}
        open={!!reasonTarget}
        itemPreview={reasonTarget?.item.content ?? ""}
        onClose={() => setReasonTarget(null)}
        onSubmit={submitReason}
      />

      <TaskEditor
        open={!!editingItem}
        onClose={() => setEditingItem(null)}
        initial={
          editingItem?.suggestion?.task ?? {
            title: editingItem?.content.slice(0, 120) ?? "",
          }
        }
        onSubmitDraft={submitEdited}
        submitLabel="Add task"
      />
    </Page>
  );
}
