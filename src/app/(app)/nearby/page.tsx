"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { locationApi, nearbyApi } from "@/lib/api";
import type { NearbyTask, Task } from "@/lib/types";
import { dueLabel } from "@/lib/format";
import { distanceLabel } from "@/lib/utils";
import { Page } from "@/components/shell/Page";
import { IconButton } from "@/components/ui/Button";
import { EmptyState, PageHeader, SkeletonRows } from "@/components/ui/Misc";
import { IconExternal, IconMapPin, IconRefresh, IconX } from "@/components/ui/icons";
import { TaskEditor } from "@/components/tasks/TaskEditor";

type Coords = { lat: number; lng: number };

function getPosition(): Promise<Coords | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolve(null),
      { timeout: 10_000, maximumAge: 60_000 },
    );
  });
}

export default function NearbyPage() {
  const [rows, setRows] = useState<NearbyTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [locating, setLocating] = useState(false);
  const [noPosition, setNoPosition] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Task | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setLocating(true);
    const near = await getPosition();
    setNoPosition(!near);
    if (near) void locationApi.report(near.lat, near.lng).catch(() => {});
    try {
      const { tasks } = await nearbyApi.list(near);
      setRows(tasks);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load nearby errands");
    } finally {
      setLocating(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Page>
      <PageHeader
        title="Nearby"
        subtitle="Errands with a place attached, closest first."
        actions={
          <IconButton label="Refresh location" onClick={() => void load()} disabled={locating}>
            <IconRefresh className={locating ? "h-5 w-5 animate-spin" : "h-5 w-5"} />
          </IconButton>
        }
      />

      {noPosition && !dismissed && !loading && rows.length > 0 ? (
        <div className="mb-4 flex items-start gap-3 rounded-2xl border border-stroke bg-sunken p-3.5">
          <IconMapPin className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-muted">
            Location unavailable — showing errands without distances. Allow location access for
            sorting.
          </p>
          <IconButton label="Dismiss location notice" size="sm" onClick={() => setDismissed(true)}>
            <IconX className="h-4 w-4" />
          </IconButton>
        </div>
      ) : null}

      {error && !loading ? (
        <p className="mb-4 rounded-2xl border border-danger/30 bg-danger/10 p-3.5 text-[13px] leading-relaxed text-danger">
          {error}
        </p>
      ) : null}

      {loading ? (
        <SkeletonRows rows={4} />
      ) : rows.length === 0 ? (
        error ? null : (
          <EmptyState
            emoji="📍"
            title="No errands have places yet"
            message="Attach a place when editing a task — or tell the assistant “add pick up prescription at CVS”."
          />
        )
      ) : (
        <ul className="space-y-2">
          <AnimatePresence initial={false} mode="popLayout">
            {rows.map(({ task, distanceKm }) => (
              <motion.li
                key={task.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
                transition={{ type: "spring", stiffness: 460, damping: 40 }}
                className="card flex items-center gap-2 p-3"
              >
                <button
                  type="button"
                  onClick={() => setEditing(task)}
                  aria-label={`Edit ${task.title}`}
                  className="flex min-w-0 flex-1 items-start gap-3 text-left"
                >
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
                    <IconMapPin className="h-[18px] w-[18px]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[15px] leading-snug text-ink">
                      {task.title}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted">
                      <span className="truncate">
                        {task.location?.name}
                        {distanceKm >= 0 ? ` · ${distanceLabel(distanceKm)}` : ""}
                      </span>
                      {task.dueAt ? (
                        <span className="text-faint">{dueLabel(task.dueAt, task.allDay)}</span>
                      ) : null}
                    </span>
                  </span>
                </button>

                {task.location ? (
                  <a
                    href={`https://www.google.com/maps/dir/?api=1&destination=${task.location.lat},${task.location.lng}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-2xl px-3 text-[13px] font-medium text-muted transition-colors hover:bg-accent-soft hover:text-ink"
                  >
                    Directions
                    <IconExternal className="h-3.5 w-3.5" />
                  </a>
                ) : null}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      <TaskEditor
        open={!!editing}
        task={editing}
        onClose={() => {
          setEditing(null);
          void load(true);
        }}
      />
    </Page>
  );
}
