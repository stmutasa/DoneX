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
import { IconCheck, IconPlus, IconSearch } from "@/components/ui/icons";
import { NoteCard } from "@/components/notes/NoteCard";
import { NoteEditor } from "@/components/notes/NoteEditor";

export default function NotesPage() {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [active, setActive] = useState<Note | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => setQ(search.trim()), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  const { data, isLoading, mutate } = useSWR<{ notes: Note[] }>(keys.notes(q || undefined), fetcher);

  const notes = useMemo(() => (data?.notes ?? []).filter((n) => !n.archived), [data]);
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
      await mutate();
      setActive(note);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create note");
    } finally {
      setCreating(false);
    }
  };

  const closeEditor = async () => {
    const note = active;
    setActive(null);
    if (note && !note.title && !note.content && !(note.items ?? []).length) {
      // Discard notes that were opened and left completely empty.
      const fresh = (await mutate())?.notes.find((n) => n.id === note.id);
      if (fresh && !fresh.title && !fresh.content && !(fresh.items ?? []).length) {
        await notesApi.remove(fresh.id).catch(() => undefined);
      }
    }
    await mutate();
  };

  return (
    <Page width="wide">
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Notes</h1>
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
          emoji="📝"
          title={q ? "No notes match that" : "Nothing jotted down yet"}
          message={
            q
              ? "Try a different word."
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
