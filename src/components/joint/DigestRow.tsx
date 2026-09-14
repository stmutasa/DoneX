"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher, jointApi } from "@/lib/api";
import { clockLabel } from "@/lib/jointDigest";
import { Button } from "@/components/ui/Button";
import { FieldLabel, SwitchRow } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { IconBell } from "@/components/ui/icons";

interface Digest {
  role: "owner" | "partner";
  enabled: boolean;
  time: string;
}

/**
 * Your own morning digest, adjustable from the shared list itself — the
 * partner never sees Settings, so this is her only way to move it.
 */
export function DigestRow() {
  const toast = useToast();
  const { data, mutate } = useSWR<Digest>("/api/joint/digest", fetcher);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState("");

  if (!data) return null;

  const save = async (patch: { enabled?: boolean; time?: string }) => {
    setSaving(true);
    try {
      const next = await jointApi.setDigest(patch);
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
      const res = await jointApi.testDigest();
      setPreview(res.digest || res.message);
      if (res.digest) toast.success(res.message);
      else toast.success(res.message);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send that");
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 flex w-full items-center gap-2.5 rounded-2xl border border-stroke bg-elev px-3.5 py-2.5 text-left transition-colors hover:border-stroke-strong"
      >
        <IconBell className="h-4 w-4 shrink-0 text-faint" />
        <span className="min-w-0 flex-1 text-[13px] text-muted">
          {data.enabled ? (
            <>
              Your morning digest at{" "}
              <span className="font-medium text-ink">{clockLabel(data.time)}</span>
            </>
          ) : (
            "Morning digest is off"
          )}
        </span>
        <span className="shrink-0 text-[13px] font-medium text-accent">Change</span>
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Your morning digest">
        <div className="space-y-4 pb-2">
          <p className="text-[13.5px] leading-relaxed text-muted">
            A short summary of the shared list, sent to your phone each morning except Sunday.
            It covers what’s tagged for you and anything neither of you has claimed — never the
            other person’s tasks. This is your own setting; it doesn’t change theirs.
          </p>

          <SwitchRow
            label="Send me a morning digest"
            checked={data.enabled}
            onChange={(v) => void save({ enabled: v })}
          />

          <div>
            <FieldLabel>Time</FieldLabel>
            <input
              type="time"
              value={data.time}
              disabled={!data.enabled || saving}
              onChange={(e) => void save({ time: e.target.value })}
              className="min-h-[44px] w-full rounded-xl border border-stroke bg-elev px-3 text-[15px] text-ink outline-none focus:border-stroke-strong disabled:opacity-50"
            />
          </div>

          <Button
            block
            loading={testing}
            disabled={!data.enabled}
            onClick={() => void sendTest()}
          >
            Send me one now
          </Button>
          {preview ? (
            <p className="rounded-2xl border border-stroke bg-sunken px-3.5 py-2.5 text-[13px] leading-relaxed text-ink">
              {preview}
            </p>
          ) : null}

          <Button variant="primary" block onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </Sheet>
    </>
  );
}
