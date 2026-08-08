"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { parseQuickPreview } from "@/lib/format";
import { PRIORITY_META } from "@/lib/types";
import type { Task } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { IconClock, IconFlag, IconFolder, IconSliders, IconTag } from "@/components/ui/icons";
import { TaskEditor } from "./TaskEditor";
import { useTaskMutations } from "./useTaskMutations";

export function QuickAddSheet({
  open,
  onClose,
  projectId,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  projectId?: string | null;
  onAdded?: (task: Task) => void;
}) {
  const { create } = useTaskMutations();
  const toast = useToast();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setText("");
      const t = window.setTimeout(() => inputRef.current?.focus(), 120);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  const preview = useMemo(() => parseQuickPreview(text), [text]);
  const hasChips =
    !!preview.project || preview.tags.length > 0 || preview.priority !== null || !!preview.when;

  const submit = async () => {
    const value = text.trim();
    if (!value) return;
    setSaving(true);
    const task = await create({ quick: value, projectId: projectId ?? undefined });
    setSaving(false);
    if (task) {
      toast.success(`Added “${task.title}”`);
      onAdded?.(task);
      setText("");
      onClose();
    }
  };

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title="Quick add"
        footer={
          <div className="flex gap-2">
            <Button
              onClick={() => {
                setEditorOpen(true);
                onClose();
              }}
              icon={<IconSliders className="h-4 w-4" />}
            >
              Details
            </Button>
            <Button block variant="primary" loading={saving} onClick={submit} disabled={!text.trim()}>
              Add task
            </Button>
          </div>
        }
      >
        <div className="pt-1">
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="Pay rent friday 5pm !p1 #home"
            enterKeyHint="done"
            className="w-full bg-transparent pb-3 text-[19px] font-medium text-ink outline-none placeholder:text-faint"
          />

          {hasChips ? (
            <div className="flex animate-fade-in flex-wrap gap-1.5 pb-2">
              {preview.when ? (
                <Chip icon={<IconClock className="h-3 w-3" />}>{preview.when}</Chip>
              ) : null}
              {preview.project ? (
                <Chip icon={<IconFolder className="h-3 w-3" />}>{preview.project}</Chip>
              ) : null}
              {preview.tags.map((t) => (
                <Chip key={t} icon={<IconTag className="h-3 w-3" />}>
                  {t}
                </Chip>
              ))}
              {preview.priority !== null ? (
                <Chip icon={<IconFlag className="h-3 w-3" />}>
                  {PRIORITY_META[preview.priority].short}
                </Chip>
              ) : null}
            </div>
          ) : null}

          <p className="pb-2 text-[13px] leading-relaxed text-faint">
            Natural language works: dates, times, <span className="text-muted">#project</span>,{" "}
            <span className="text-muted">@tag</span>, <span className="text-muted">!p1</span>.
          </p>
        </div>
      </Sheet>

      <TaskEditor
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        initial={{ title: text.trim(), projectId: projectId ?? null }}
        onSaved={onAdded}
      />
    </>
  );
}

function Chip({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-[12px] font-medium text-accent">
      {icon}
      {children}
    </span>
  );
}
