"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { fetcher, keys } from "@/lib/api";
import { parseQuickPreview } from "@/lib/format";
import { PRIORITY_META } from "@/lib/types";
import type { Project, SessionRole, Task, TaskDraft } from "@/lib/types";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { IconClock, IconFlag, IconFolder, IconSliders, IconTag } from "@/components/ui/icons";
import { TaskEditor } from "./TaskEditor";
import { useTaskMutations } from "./useTaskMutations";

const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

/**
 * What the server's quick add would make of the text, for the editor to
 * start from: the editor saves fields, so tokens left in the title would be
 * saved as words.
 */
async function draftFromQuickText(
  text: string,
  tz: string,
  projectId: string | null,
  projects: Project[],
): Promise<Partial<TaskDraft>> {
  if (!text) return { title: "", projectId };
  try {
    // Loaded on demand: the parser is big, and only Details needs it here.
    const { parseQuickAdd } = await import("@/lib/quickparse");
    const { draft, matchedText } = parseQuickAdd(text, tz);
    let title = draft.title;
    let project = projectId;
    const name = matchedText.project;
    // The page's own project wins, as it does for a quick add.
    if (name && !project) {
      const match = projects.find(
        (p) => !p.archived && p.name.trim().toLowerCase() === name.trim().toLowerCase(),
      );
      if (match) project = match.id;
      // A quick add would create the project; the editor can't, so keep the
      // name in view rather than drop it silently.
      else title = `${title} #${/\s/.test(name) ? `"${name}"` : name}`.trim();
    }
    return { ...draft, title: title || text, projectId: project };
  } catch {
    // Parser not available (offline before it was ever loaded): start from the raw text.
    return { title: text, projectId };
  }
}

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
  const { create, save } = useTaskMutations();
  const toast = useToast();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorInitial, setEditorInitial] = useState<Partial<TaskDraft>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  // Set the moment a submit starts, before any re-render, so a second Enter
  // (or key repeat) can't add the same text again. A success keeps it set
  // until the cleared text has rendered.
  const inFlight = useRef(false);
  // Details is parsing the text: Add and Details wait, so the same text can't
  // be added and also opened in the editor.
  const [detailsPending, setDetailsPending] = useState(false);
  const detailsRef = useRef(false);
  const openRef = useRef(open);

  // The app's zone (settings.tz, which /api/auth/me carries), as the server
  // parses quick adds in it; the device's is the last resort.
  const { data: me } = useSWR<{ role: SessionRole; tz?: string }>(
    open ? keys.me() : null,
    fetcher,
  );
  const { data: projectData } = useSWR<{ projects: Project[] }>(
    open ? keys.projects() : null,
    fetcher,
  );
  const tz = me?.tz || deviceTz;

  useEffect(() => {
    openRef.current = open;
    if (open) {
      setText("");
      // Fetch the parser now, so Details is instant and the chunk is cached
      // for offline use.
      void import("@/lib/quickparse").catch(() => undefined);
      const t = window.setTimeout(() => inputRef.current?.focus(), 120);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  useEffect(() => {
    if (!text) inFlight.current = false;
  }, [text]);

  const preview = useMemo(() => parseQuickPreview(text), [text]);
  const hasChips =
    !!preview.project || preview.tags.length > 0 || preview.priority !== null || !!preview.when;

  const submit = async () => {
    const value = text.trim();
    if (!value || inFlight.current || detailsRef.current) return;
    inFlight.current = true;
    setSaving(true);
    let task: Task | null = null;
    try {
      task = await create({ quick: value, projectId: projectId ?? undefined });
      // The quick parser only sees the text, so scope it to the project explicitly.
      if (task && projectId && task.projectId !== projectId) {
        // Merge: offline, the answer can be just the patched fields.
        const patched = await save(task.id, { projectId });
        if (patched) task = { ...task, ...patched };
      }
    } finally {
      setSaving(false);
      if (!task) inFlight.current = false;
    }
    if (task) {
      toast.success(`Added “${task.title}”`);
      onAdded?.(task);
      setText("");
      onClose();
    }
  };

  const openDetails = async () => {
    if (detailsRef.current || inFlight.current) return;
    detailsRef.current = true;
    setDetailsPending(true);
    try {
      const initial = await draftFromQuickText(
        text.trim(),
        tz,
        projectId ?? null,
        projectData?.projects ?? [],
      );
      // Closed while the parser loaded: don't pop the editor open on its own.
      if (!openRef.current) return;
      setEditorInitial(initial);
      setEditorOpen(true);
      onClose();
    } finally {
      detailsRef.current = false;
      setDetailsPending(false);
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
              onClick={() => void openDetails()}
              disabled={saving || detailsPending}
              icon={<IconSliders className="h-4 w-4" />}
            >
              Details
            </Button>
            <Button
              block
              variant="primary"
              loading={saving}
              onClick={submit}
              disabled={!text.trim() || detailsPending}
            >
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
        initial={editorInitial}
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
