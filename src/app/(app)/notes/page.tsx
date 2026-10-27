"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { AnimatePresence } from "framer-motion";
import { fetcher, keys, notesApi } from "@/lib/api";
import type { Note } from "@/lib/types";
import { Page } from "@/components/shell/Page";
import { EmptyState, SectionLabel } from "@/components/ui/Misc";
import { Input } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { IconArchive, IconCheck, IconPlus, IconSearch } from "@/components/ui/icons";
import { NoteCard } from "@/components/notes/NoteCard";
import { NoteEditor } from "@/components/notes/NoteEditor";

/** The notes list key; archived notes are a separate list so they can be restored. */
function notesKey(q: string, archived: boolean): string {
  const key = keys.notes(q || undefined);
  return archived ? `${key}${key.includes("?") ? "&" : "?"}archived=1` : key;
}

const isBlank = (note: Note) => !note.title && !note.content && !(note.items ?? []).length;

export default function NotesPage() {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [active, setActive] = useState<Note | null>(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setQ(search.trim()), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  const { data, isLoading, mutate } = useSWR<{ notes: Note[] }>(notesKey(q, showArchived), fetcher);

  const notes = useMemo(
    () => (data?.notes ?? []).filter((n) => n.archived === showArchived),
    [data, showArchived],
  );
  const pinned = notes.filter((n) => n.pinned);
  const rest = notes.filter((n) => !n.pinned);

  const createNote = async (kind: Note["kind"]) => {
    if (creating) return;
    setCreating(true);
    try {
      const { note } = await notesApi.create({
        kind,
        title: "",
        content: "",
        items: [],
        color: null,
        pinned: false,
      });
      // A new note belongs to the live list, so leave the archive to show it.
      if (showArchived) setShowArchived(false);
      else await mutate();
      setActive(note);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create note");
    } finally {
      setCreating(false);
    }
  };

  const closeEditor = async (saved: Note | null) => {
    const note = active;
    setActive(null);
    // Discard notes that were opened and left completely empty. `saved` is the
    // editor's last confirmed copy (null when the save state is unknown); the
    // server's copy is checked too, by id so the search can't hide it, in case
    // another device filled the note in meanwhile.
    if (note && isBlank(note) && saved && !saved.archived && isBlank(saved)) {
      const fresh = await fetcher<{ note: Note }>(`/api/notes/${saved.id}`).then(
        (res) => res.note,
        () => null,
      );
      if (fresh && !fresh.archived && isBlank(fresh)) {
        await notesApi.remove(fresh.id).catch(() => undefined);
      }
    }
    await mutate();
  };

  return (
    <Page width="wide">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            {showArchived ? "Archived notes" : "Notes"}
          </h1>
          <button
            type="button"
            onClick={() => setShowArchived((a) => !a)}
            aria-pressed={showArchived}
            className="inline-flex min-h-[36px] shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] text-muted transition-colors hover:bg-accent-soft hover:text-ink"
          >
            <IconArchive className="h-4 w-4" />
            {showArchived ? "Back to notes" : "Show archived"}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 sm:w-56">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search notes"
              aria-label="Search notes"
              leading={<IconSearch className="h-4 w-4" />}
              type="search"
            />
          </div>
          <div className="flex shrink-0 overflow-hidden rounded-2xl border border-stroke">
            <button
              type="button"
              onClick={() => createNote("note")}
              className="flex min-h-[44px] items-center gap-1.5 bg-elev px-3 text-[13.5px] font-medium text-ink transition-colors hover:bg-sunken"
            >
              <IconPlus className="h-4 w-4 text-accent" />
              Note
            </button>
            <button
              type="button"
              onClick={() => createNote("checklist")}
              className="flex min-h-[44px] items-center gap-1.5 border-l border-stroke bg-elev px-3 text-[13.5px] font-medium text-ink transition-colors hover:bg-sunken"
            >
              <IconCheck className="h-4 w-4 text-accent" />
              List
            </button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="columns-2 gap-3 sm:columns-3 lg:columns-4">
          {[112, 168, 88, 140, 120, 96].map((h, i) => (
            <div key={i} className="skeleton mb-3 break-inside-avoid rounded-2xl" style={{ height: h }} />
          ))}
        </div>
      ) : notes.length === 0 ? (
        <EmptyState
          emoji={showArchived ? "🗄️" : "📝"}
          title={q ? "No notes match that" : showArchived ? "No archived notes" : "Nothing jotted down yet"}
          message={
            q
              ? "Try a different word."
              : showArchived
                ? "Notes you archive wait here until you restore them."
                : "Notes and checklists live here — groceries, ideas, half-formed thoughts."
          }
        />
      ) : (
        <>
          {pinned.length ? (
            <section className="mb-5">
              <SectionLabel>Pinned</SectionLabel>
              <div className="columns-2 gap-3 sm:columns-3 lg:columns-4">
                <AnimatePresence initial={false}>
                  {pinned.map((note) => (
                    <NoteCard key={note.id} note={note} onOpen={setActive} onChanged={() => void mutate()} />
                  ))}
                </AnimatePresence>
              </div>
            </section>
          ) : null}

          {rest.length ? (
            <section>
              {pinned.length ? <SectionLabel>Others</SectionLabel> : null}
              <div className="columns-2 gap-3 sm:columns-3 lg:columns-4">
                <AnimatePresence initial={false}>
                  {rest.map((note) => (
                    <NoteCard key={note.id} note={note} onOpen={setActive} onChanged={() => void mutate()} />
                  ))}
                </AnimatePresence>
              </div>
            </section>
          ) : null}
        </>
      )}

      <NoteEditor
        note={active}
        open={!!active}
        onClose={closeEditor}
        onChanged={() => void mutate()}
      />
    </Page>
  );
}
