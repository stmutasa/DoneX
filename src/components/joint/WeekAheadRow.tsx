"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher, jointApi, type WeekAheadState } from "@/lib/api";
import { clockLabel } from "@/lib/jointDigest";
import { Button } from "@/components/ui/Button";
import { FieldLabel, SwitchRow } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { IconCalendar } from "@/components/ui/icons";

/**
 * The Sunday look at the week to come, adjustable from the shared list —
 * the partner never sees Settings, so this is her only way to move hers.
 * The last one sent is kept here too, since a swiped notification is gone.
 */
export function WeekAheadRow() {
  const toast = useToast();
  const { data, mutate } = useSWR<WeekAheadState>("/api/joint/weekahead", fetcher);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState("");

  if (!data) return null;

  const save = async (patch: { enabled?: boolean; time?: string }) => {
    setSaving(true);
    try {
      const next = await jointApi.setWeekAhead(patch);
      await mutate(next, { revalidate: false });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save that");
    } finally {
      setSaving(false);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    setPreview("");
    try {
      const res = await jointApi.testWeekAhead();
      setPreview(res.text || res.message);
      toast.success(res.message);
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send that");
    } finally {
      setTesting(false);
    }
  };

  const shown = preview || data.last?.text || "";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 flex w-full items-center gap-2.5 rounded-2xl border border-stroke bg-elev px-3.5 py-2.5 text-left transition-colors hover:border-stroke-strong"
      >
        <IconCalendar className="h-4 w-4 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 text-[13px] text-muted">
          {data.enabled ? (
            <>
              Week ahead, Sundays at{" "}
              <span className="font-medium text-ink">{clockLabel(data.time)}</span>
            </>
          ) : (
            "Week ahead is off"
          )}
        </span>
        <span className="shrink-0 text-[13px] font-medium text-accent">Change</span>
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Your week ahead">
        <div className="space-y-4 pb-2">
          <p className="text-[13.5px] leading-relaxed text-muted">
            Sunday evening, a look at the seven days coming: what’s tagged for you on the
            shared list, what neither of you has claimed, and what’s on both calendars. You
            get a count of how much the other person is carrying, never their list. This is
            your own setting; it doesn’t change theirs.
          </p>

          <SwitchRow
            label="Send me a Sunday week-ahead"
            checked={data.enabled}
            onChange={(v) => void save({ enabled: v })}
          />

          <div>
            <FieldLabel>Time on Sunday</FieldLabel>
            <input
              type="time"
              value={data.time}
              disabled={!data.enabled || saving}
              onChange={(e) => void save({ time: e.target.value })}
              className="min-h-[44px] w-full rounded-xl border border-stroke bg-elev px-3 text-[15px] text-ink outline-none focus:border-stroke-strong disabled:opacity-50"
            />
          </div>

          <Button block loading={testing} onClick={() => void sendTest()}>
            Send me one now
          </Button>

          {shown ? (
            <div className="rounded-2xl border border-stroke bg-sunken px-3.5 py-2.5">
              {!preview && data.last?.weekOf ? (
                <p className="mb-1 text-[11.5px] uppercase tracking-wide text-faint">
                  Last sent · week of {data.last.weekOf}
                </p>
              ) : null}
              <p className="text-[13px] leading-relaxed text-ink">{shown}</p>
            </div>
          ) : null}

          <Button variant="primary" block onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </Sheet>
    </>
  );
}
