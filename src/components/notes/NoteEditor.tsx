"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { notesApi } from "@/lib/api";
import type { ChecklistItem, Note } from "@/lib/types";
import { NOTE_COLORS } from "@/lib/types";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAutoGrow } from "@/hooks/useAutoGrow";
import { Sheet } from "@/components/ui/Sheet";
import { Button, IconButton } from "@/components/ui/Button";
import { useConfirm } from "@/components/ui/Confirm";
import { useToast } from "@/components/ui/Toast";
import { IconArchive, IconCheck, IconPin, IconPlus, IconTrash, IconX } from "@/components/ui/icons";
import { noteSwatch } from "./noteColors";

let itemSeq = 0;
const newItemId = () => `ci-${Date.now().toString(36)}-${++itemSeq}`;

export function NoteEditor({
  note,
  open,
  onClose,
  onChanged,
}: {
  note: Note | null;
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const confirm = useConfirm();
  const toast = useToast();

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [color, setColor] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [itemDraft, setItemDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  useAutoGrow(contentRef, content, 420);

  useEffect(() => {
    if (!note || !open) return;
    setTitle(note.title);
    setContent(note.content);
    setItems(note.items ?? []);
    setColor(note.color);
    setPinned(note.pinned);
    setItemDraft("");
    setDirty(false);
    setSavedAt(note.updatedAt);
  }, [note, open]);

  const persist = useCallback(async () => {
    if (!note) return;
    setSaving(true);
    try {
      const { note: saved } = await notesApi.update(note.id, {
        title,
        content,
        items,
        color,
        pinned,
      });
      setSavedAt(saved.updatedAt);
      setDirty(false);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save note");
    } finally {
      setSaving(false);
    }
  }, [note, title, content, items, color, pinned, onChanged, toast]);

  const touch = () => setDirty(true);

  // Deliberately no autosave-while-typing: a note only writes to the server
  // when you tap Save, or when you close it (so backing out never silently
  // discards what you typed).
  const close = async () => {
    if (dirty) await persist();
    onClose();
  };

  const addItem = () => {
    const text = itemDraft.trim();
    if (!text) return;
    setItems((prev) => [...prev, { id: newItemId(), text, done: false }]);
    setItemDraft("");
    touch();
  };

  const onArchive = async () => {
    if (!note) return;
    try {
      await notesApi.update(note.id, { archived: !note.archived });
      toast.success(note.archived ? "Note restored" : "Note archived");
      onChanged();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not archive");
    }
  };

  const onDelete = async () => {
    if (!note) return;
    const ok = await confirm({
      title: "Delete this note?",
      message: "This can’t be undone.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await notesApi.remove(note.id);
      toast.success("Note deleted");
      onChanged();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete");
    }
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      size="lg"
      title={note?.kind === "checklist" ? "Checklist" : "Note"}
      subtitle={
        saving
          ? "Saving…"
          : dirty
            ? "Unsaved changes"
            : savedAt
              ? `Saved ${relativeTime(savedAt)}`
              : undefined
      }
      actions={
        <>
          <IconButton
            label={pinned ? "Unpin note" : "Pin note"}
            size="sm"
            active={pinned}
            onClick={() => {
              setPinned((p) => !p);
              touch();
            }}
          >
            <IconPin className="h-[18px] w-[18px]" />
          </IconButton>
          <IconButton label="Archive note" size="sm" onClick={onArchive}>
            <IconArchive className="h-[18px] w-[18px]" />
          </IconButton>
          <IconButton label="Delete note" size="sm" className="text-danger" onClick={onDelete}>
            <IconTrash className="h-[18px] w-[18px]" />
          </IconButton>
        </>
      }
      footer={
        <div className="flex items-center gap-2">
          <div className="flex flex-1 items-center gap-1.5">
            <button
              type="button"
              aria-label="No colour"
              onClick={() => {
                setColor(null);
                touch();
              }}
              className={cn(
                "h-8 w-8 rounded-full border-2 transition-transform active:scale-95",
                color === null && "ring-2 ring-accent ring-offset-2 ring-offset-elev",
              )}
              style={noteSwatch(null)}
            />
            {NOTE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Colour ${c}`}
                onClick={() => {
                  setColor(c);
                  touch();
                }}
                className={cn(
                  "h-8 w-8 rounded-full border-2 transition-transform active:scale-95",
                  color === c && "ring-2 ring-accent ring-offset-2 ring-offset-elev",
                )}
                style={noteSwatch(c)}
              />
            ))}
          </div>
          {dirty ? (
            <Button size="sm" variant="primary" loading={saving} onClick={persist}>
              Save
            </Button>
          ) : savedAt ? (
            <span className="flex items-center gap-1 text-[12px] text-ok">
              <IconCheck className="h-3.5 w-3.5" strokeWidth={3} /> Saved
            </span>
          ) : null}
        </div>
      }
    >
      <div className="space-y-3 pt-1">
        <input
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            touch();
          }}
          placeholder="Title"
          className="w-full bg-transparent text-[19px] font-medium text-ink outline-none placeholder:text-faint"
        />

        {note?.kind === "checklist" ? (
          <div className="space-y-1.5">
            {items.map((item, index) => (
              <div key={item.id} className="flex items-center gap-2">
                <button
                  type="button"
                  aria-label={item.done ? `Uncheck ${item.text}` : `Check ${item.text}`}
                  onClick={() => {
                    setItems((prev) =>
                      prev.map((it, i) => (i === index ? { ...it, done: !it.done } : it)),
                    );
                    touch();
                  }}
                  className={cn(
                    "grid h-6 w-6 shrink-0 place-items-center rounded-[7px] border-2 transition-colors",
                    item.done
                      ? "border-transparent bg-sunrise text-on-accent"
                      : "border-stroke-strong text-transparent",
                  )}
                >
                  <IconCheck className="h-3 w-3" strokeWidth={3.5} />
                </button>
                <input
                  value={item.text}
                  onChange={(e) => {
                    const value = e.target.value;
                    setItems((prev) =>
                      prev.map((it, i) => (i === index ? { ...it, text: value } : it)),
                    );
                    touch();
                  }}
                  className={cn(
                    "min-w-0 flex-1 bg-transparent py-1.5 text-[15px] text-ink outline-none",
                    item.done && "task-done-title",
                  )}
                />
                <IconButton
                  label={`Delete item ${item.text}`}
                  size="sm"
                  onClick={() => {
                    setItems((prev) => prev.filter((_, i) => i !== index));
                    touch();
                  }}
                >
                  <IconX className="h-3.5 w-3.5" />
                </IconButton>
              </div>
            ))}

            <div className="flex items-center gap-2 pt-1">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-faint">
                <IconPlus className="h-4 w-4" />
              </span>
              <input
                value={itemDraft}
                onChange={(e) => setItemDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addItem();
                  }
                }}
                onBlur={addItem}
                placeholder="List item"
                className="min-w-0 flex-1 bg-transparent py-1.5 text-[15px] text-ink outline-none placeholder:text-faint"
              />
            </div>
          </div>
        ) : (
          <textarea
            ref={contentRef}
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              touch();
            }}
            placeholder="Write something…"
            rows={6}
            className="w-full resize-none bg-transparent text-[15px] leading-relaxed text-ink outline-none placeholder:text-faint"
          />
        )}
      </div>
    </Sheet>
  );
}
