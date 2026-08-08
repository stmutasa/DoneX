"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { notesApi } from "@/lib/api";
import type { ChecklistItem, Note } from "@/lib/types";
import { cn } from "@/lib/utils";
import { IconCheck, IconPin } from "@/components/ui/icons";
import { noteSurface } from "./noteColors";

const PREVIEW_ITEMS = 6;

export function NoteCard({
  note,
  onOpen,
  onChanged,
}: {
  note: Note;
  onOpen: (note: Note) => void;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<ChecklistItem[]>(note.items ?? []);

  useEffect(() => setItems(note.items ?? []), [note.items]);

  const doneCount = items.filter((i) => i.done).length;
  const visible = items.slice(0, PREVIEW_ITEMS);
  const hidden = Math.max(0, items.length - PREVIEW_ITEMS);

  const toggleItem = async (id: string) => {
    const next = items.map((i) => (i.id === id ? { ...i, done: !i.done } : i));
    setItems(next);
    try {
      await notesApi.update(note.id, { items: next });
      onChanged?.();
    } catch {
      setItems(items);
    }
  };

  return (
    <motion.article
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: "spring", stiffness: 420, damping: 38 }}
      className="mb-3 break-inside-avoid rounded-2xl border border-stroke bg-elev p-3.5 shadow-soft transition-shadow hover:shadow-lift"
      style={noteSurface(note.color)}
    >
      <button
        type="button"
        onClick={() => onOpen(note)}
        className="w-full text-left"
        aria-label={`Open note ${note.title || "Untitled"}`}
      >
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 text-[15px] font-medium leading-snug text-ink">
            {note.title || <span className="text-faint">Untitled</span>}
          </h3>
          {note.pinned ? <IconPin className="h-4 w-4 shrink-0 text-accent" /> : null}
        </div>

        {note.kind === "note" && note.content ? (
          <p className="mt-1.5 line-clamp-6 whitespace-pre-wrap text-[13.5px] leading-relaxed text-muted">
            {note.content}
          </p>
        ) : null}
      </button>

      {note.kind === "checklist" ? (
        <div className="mt-2 space-y-1">
          {visible.map((item) => (
            <div key={item.id} className="flex items-start gap-2">
              <button
                type="button"
                onClick={() => toggleItem(item.id)}
                aria-label={item.done ? `Uncheck ${item.text}` : `Check ${item.text}`}
                aria-pressed={item.done}
                className="-m-1.5 grid h-8 w-8 shrink-0 place-items-center rounded-full"
              >
                <span
                  className={cn(
                    "grid h-[17px] w-[17px] place-items-center rounded-[6px] border-2 transition-colors",
                    item.done
                      ? "border-transparent bg-sunrise text-on-accent"
                      : "border-stroke-strong text-transparent",
                  )}
                >
                  <IconCheck className="h-2.5 w-2.5" strokeWidth={3.5} />
                </span>
              </button>
              <span
                className={cn(
                  "min-w-0 flex-1 text-[13.5px] leading-[1.5] text-ink",
                  item.done && "task-done-title",
                )}
              >
                {item.text}
              </span>
            </div>
          ))}
          {hidden > 0 ? (
            <button
              type="button"
              onClick={() => onOpen(note)}
              className="pl-[26px] pt-0.5 text-[12.5px] text-faint"
            >
              + {hidden} more
            </button>
          ) : null}
          {items.length ? (
            <span className="mt-1.5 inline-flex rounded-full bg-sunken px-2 py-0.5 text-[11px] font-medium text-muted">
              {doneCount}/{items.length}
            </span>
          ) : null}
        </div>
      ) : null}
    </motion.article>
  );
}
