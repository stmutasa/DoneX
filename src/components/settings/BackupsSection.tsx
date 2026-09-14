"use client";

import { useState } from "react";
import useSWR from "swr";
import { backupsApi, fetcher } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { SkeletonRows } from "@/components/ui/Misc";
import { useConfirm } from "@/components/ui/Confirm";
import { useToast } from "@/components/ui/Toast";
import { IconDownload, IconTrash } from "@/components/ui/icons";
import { Divider, SettingsCard } from "./common";

interface Snapshot {
  name: string;
  createdAt: string;
  kind: string;
  bytes: number;
  counts: Record<string, number>;
}

interface Payload {
  snapshots: Snapshot[];
  status: { lastAt: string | null; lastOk: boolean; lastError: string | null; lastBytes: number };
  daysSince: number | null;
}

const KIND_LABEL: Record<string, string> = {
  weekly: "Weekly",
  manual: "Manual",
  "pre-restore": "Before a restore",
  unreadable: "Unreadable",
};

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function itemCount(counts: Record<string, number>): number {
  return Object.entries(counts)
    .filter(([table]) => table !== "settings" && table !== "google_tokens")
    .reduce((n, [, c]) => n + c, 0);
}

export function BackupsSection() {
  const toast = useToast();
  const confirm = useConfirm();
  const { data, isLoading, mutate } = useSWR<Payload>("/api/backups", fetcher);
  const [busy, setBusy] = useState(false);

  const backUpNow = async () => {
    setBusy(true);
    try {
      const { snapshot } = await backupsApi.create();
      await mutate();
      toast.success(`Saved ${itemCount(snapshot.counts)} items (${sizeLabel(snapshot.bytes)})`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Backup failed");
    } finally {
      setBusy(false);
    }
  };

  const restore = async (snap: Snapshot) => {
    const everything = await confirm({
      title: "Restore this backup?",
      message:
        "Your tasks, notes, projects, inbox and history are replaced with the contents of this file. A copy of how things look right now is saved first, so this can be undone.",
      confirmLabel: "Restore data",
    });
    if (!everything) return;
    setBusy(true);
    try {
      const res = await backupsApi.restore(snap.name, false);
      await mutate();
      const n = Object.values(res.restored).reduce((a, b) => a + b, 0);
      toast.success(`Restored ${n} rows. Reload to see them.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Restore failed");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (snap: Snapshot) => {
    const ok = await confirm({
      title: "Delete this backup?",
      message: "It's removed from the server. Any copy you downloaded is untouched.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await backupsApi.remove(snap.name);
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete it");
    }
  };

  const stale = data?.daysSince !== null && data?.daysSince !== undefined && data.daysSince > 9;

  return (
    <SettingsCard
      id="backups"
      title="Backups"
      description="A snapshot of everything, taken weekly and kept on the server."
    >
      {isLoading && !data ? (
        <SkeletonRows rows={3} />
      ) : (
        <>
          <div
            className={cn(
              "rounded-2xl border px-3.5 py-3 text-[13px] leading-relaxed",
              data?.status.lastOk && !stale
                ? "border-stroke bg-sunken text-muted"
                : "border-warn/40 bg-warn/10 text-warn",
            )}
          >
            {data?.status.lastAt ? (
              data.status.lastOk ? (
                <>
                  Last backup {relativeTime(data.status.lastAt)} ·{" "}
                  {sizeLabel(data.status.lastBytes)}
                  {stale ? " — that's a while ago; take one now." : ""}
                </>
              ) : (
                <>The last backup failed: {data.status.lastError}</>
              )
            ) : (
              <>No backup yet. One runs automatically each Sunday evening.</>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={busy} onClick={() => void backUpNow()}>
              Back up now
            </Button>
          </div>

          <p className="text-[12px] leading-snug text-faint">
            Snapshots live on the same server as the app, which protects you from a bad import
            or a change you regret — but not from losing the server itself. Download one now
            and then whenever the Sunday reminder arrives, and you always have a copy elsewhere.
            The file includes your settings and API keys, so treat it like a password.
          </p>

          {data && data.snapshots.length > 0 ? (
            <>
              <Divider />
              <ul className="space-y-2">
                {data.snapshots.map((snap) => (
                  <li
                    key={snap.name}
                    className="rounded-2xl border border-stroke bg-elev px-3.5 py-2.5"
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
                        {relativeTime(snap.createdAt)}
                      </span>
                      <span className="shrink-0 text-[12px] text-faint">
                        {KIND_LABEL[snap.kind] ?? snap.kind}
                      </span>
                    </div>
                    <div className="mt-0.5 text-[12px] text-muted">
                      {itemCount(snap.counts)} items · {sizeLabel(snap.bytes)}
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <a
                        href={backupsApi.downloadUrl(snap.name)}
                        download
                        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border border-stroke px-3 text-[13px] font-medium text-ink transition-colors hover:border-stroke-strong"
                      >
                        <IconDownload className="h-3.5 w-3.5 text-accent" />
                        Download
                      </a>
                      <Button size="sm" disabled={busy} onClick={() => void restore(snap)}>
                        Restore
                      </Button>
                      <span className="flex-1" />
                      <button
                        type="button"
                        onClick={() => void remove(snap)}
                        aria-label={`Delete the backup from ${snap.createdAt}`}
                        className="grid h-9 w-9 place-items-center rounded-xl text-faint transition-colors hover:text-danger"
                      >
                        <IconTrash className="h-4 w-4" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </SettingsCard>
  );
}
