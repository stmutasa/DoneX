"use client";

import { useEffect, useRef, useState } from "react";

const SAVE_AFTER_MS = 1000;
const FULL_TIME = /^\d{2}:\d{2}$/;

/**
 * A time field that saves once the user is done with it, not on every
 * segment. Desktop browsers fire change as soon as the hour is typed; saving
 * then would snap the field back to the old value mid-edit and drop the
 * minutes. An edit saves on blur, after a short pause, or on unmount, and
 * only when it is a full HH:mm that isn't already saved or on its way.
 * Until the user edits it, the field follows the saved value, so a change
 * made elsewhere is never sent back over. A failed save puts the saved time
 * back. `onSave` resolves true once the time is stored.
 */
export function DraftTimeInput({
  value,
  onSave,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  onSave: (next: string) => Promise<boolean>;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const [draft, setDraft] = useState(value);
  /** The user changed the field since it last synced or saved. */
  const dirty = useRef(false);
  /** The last time handed to onSave that hasn't come back as `value` yet. */
  const sent = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  const latest = useRef({ draft, value, onSave });
  latest.current = { draft, value, onSave };

  useEffect(() => {
    if (sent.current !== null) {
      // An earlier save landing while a later one is still out: wait for that.
      if (value !== sent.current) return;
      sent.current = null;
    }
    if (!dirty.current) setDraft(value);
  }, [value]);

  const commit = () => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty.current) return;
    const { draft: next, value: saved, onSave: save } = latest.current;
    if (!FULL_TIME.test(next)) return;
    dirty.current = false;
    if (next === (sent.current ?? saved)) return;
    sent.current = next;
    const settle = (ok: boolean) => {
      if (sent.current === next) sent.current = null;
      // Show what is really saved (or still on its way), unless the user is
      // already typing again.
      if (!ok && !dirty.current) setDraft(sent.current ?? latest.current.value);
    };
    save(next).then(settle, () => settle(false));
  };

  // Leaving (closing the sheet, navigating) still saves a pending edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => commit(), []);

  return (
    <input
      type="time"
      aria-label={ariaLabel}
      value={draft}
      disabled={disabled}
      onFocus={() => {
        if (!dirty.current && sent.current === null) setDraft(latest.current.value);
      }}
      onChange={(e) => {
        const next = e.target.value;
        dirty.current = true;
        setDraft(next);
        latest.current.draft = next;
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(commit, SAVE_AFTER_MS);
      }}
      onBlur={() => {
        commit();
        // A cleared or half-typed field goes back to the saved time.
        if (!FULL_TIME.test(latest.current.draft)) {
          dirty.current = false;
          setDraft(sent.current ?? latest.current.value);
        }
      }}
      className={className}
    />
  );
}
