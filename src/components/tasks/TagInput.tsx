"use client";

import { useId, useState } from "react";
import { cn } from "@/lib/utils";
import { IconX } from "@/components/ui/icons";
import { FieldLabel } from "@/components/ui/Field";

export function TagInput({
  value,
  onChange,
  suggestions = [],
  label = "Tags",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: string[];
  label?: string;
}) {
  const [draft, setDraft] = useState("");
  const listId = useId();

  const add = (raw: string) => {
    const tag = raw.trim().replace(/^#/, "").toLowerCase();
    if (!tag) return;
    if (!value.includes(tag)) onChange([...value, tag]);
    setDraft("");
  };

  const unused = suggestions.filter((s) => !value.includes(s)).slice(0, 8);

  return (
    <div>
      <FieldLabel htmlFor={`${listId}-input`}>{label}</FieldLabel>
      <div
        className={cn(
          "flex min-h-[44px] flex-wrap items-center gap-1.5 rounded-2xl border border-stroke bg-sunken px-2.5 py-1.5",
          "focus-within:border-stroke-strong",
        )}
      >
        {value.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-1 text-[12px] font-medium text-accent"
          >
            #{tag}
            <button
              type="button"
              onClick={() => onChange(value.filter((t) => t !== tag))}
              aria-label={`Remove tag ${tag}`}
              className="grid h-4 w-4 place-items-center rounded-full hover:bg-accent/20"
            >
              <IconX className="h-2.5 w-2.5" strokeWidth={2.6} />
            </button>
          </span>
        ))}
        <input
          id={`${listId}-input`}
          list={listId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "," || e.key === " ") {
              if (draft.trim()) {
                e.preventDefault();
                add(draft);
              }
            } else if (e.key === "Backspace" && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onBlur={() => draft.trim() && add(draft)}
          placeholder={value.length ? "" : "Add a tag…"}
          className="min-w-[100px] flex-1 bg-transparent py-1 text-[14px] text-ink outline-none placeholder:text-faint"
        />
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
      {unused.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {unused.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => add(s)}
              className="rounded-full border border-stroke px-2 py-1 text-[12px] text-muted transition-colors hover:text-ink"
            >
              #{s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
