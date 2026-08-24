"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { ApiError, placesApi } from "@/lib/api";
import type { PlaceResult, TaskLocation } from "@/lib/types";
import { Button, IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { IconMapPin, IconSearch, IconX } from "@/components/ui/icons";

type Coords = { lat: number; lng: number };

/** Shared across editor mounts so opening a task twice never re-prompts. */
let sharedNear: Coords | null = null;
let nearAsked = false;

export function LocationField({
  value,
  onChange,
}: {
  value: TaskLocation | null;
  onChange: (location: TaskLocation | null) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PlaceResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsKey, setNeedsKey] = useState(false);
  const nearRef = useRef<Coords | null>(sharedNear);

  // Best-effort bias only — a denied or slow fix just means an unbiased search.
  useEffect(() => {
    if (value || nearAsked || typeof navigator === "undefined" || !navigator.geolocation) return;
    nearAsked = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        sharedNear = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        nearRef.current = sharedNear;
      },
      () => {},
      { timeout: 3000, maximumAge: 300_000 },
    );
  }, [value]);

  const search = async () => {
    const term = q.trim();
    if (!term || busy) return;
    setBusy(true);
    setError(null);
    setNeedsKey(false);
    try {
      const { places } = await placesApi.search(term, nearRef.current ?? sharedNear);
      setResults(places);
    } catch (err) {
      setResults(null);
      if (err instanceof ApiError && err.status === 409) setNeedsKey(true);
      else setError(err instanceof Error ? err.message : "Place search failed");
    } finally {
      setBusy(false);
    }
  };

  const pick = (place: PlaceResult) => {
    onChange(place);
    setResults(null);
    setQ("");
    setError(null);
    setNeedsKey(false);
  };

  if (value) {
    return (
      <div className="flex min-h-[44px] items-center gap-2.5 rounded-2xl border border-stroke bg-sunken px-3 py-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
          <IconMapPin className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] leading-snug text-ink">{value.name}</span>
          {value.address ? (
            <span className="block truncate text-[12px] leading-snug text-muted">
              {value.address}
            </span>
          ) : null}
        </span>
        <IconButton label="Remove location" size="sm" onClick={() => onChange(null)}>
          <IconX className="h-4 w-4" />
        </IconButton>
      </div>
    );
  }

  return (
    <div>
      <div className="flex gap-2">
        <Input
          value={q}
          placeholder="Search for a place…"
          enterKeyHint="search"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void search();
            }
          }}
        />
        <Button
          loading={busy}
          disabled={!q.trim()}
          onClick={() => void search()}
          icon={<IconSearch className="h-4 w-4" />}
        >
          Search
        </Button>
      </div>

      {needsKey ? (
        <p className="mt-1.5 px-1 text-[12.5px] leading-relaxed text-muted">
          Add a Maps API key in{" "}
          <Link href="/settings/google" className="font-medium text-accent">
            Settings → Google
          </Link>{" "}
          to attach places
        </p>
      ) : error ? (
        <p className="mt-1.5 px-1 text-[12.5px] leading-relaxed text-danger">{error}</p>
      ) : null}

      <AnimatePresence initial={false}>
        {results ? (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mt-2 overflow-hidden rounded-2xl border border-stroke bg-sunken"
          >
            {results.length ? (
              <ul className="divide-y divide-stroke">
                {results.map((place) => (
                  <li key={`${place.name}-${place.lat}-${place.lng}`}>
                    <button
                      type="button"
                      onClick={() => pick(place)}
                      className="flex min-h-[44px] w-full items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-elev"
                    >
                      <IconMapPin className="h-4 w-4 shrink-0 text-faint" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] leading-snug text-ink">
                          {place.name}
                        </span>
                        {place.address ? (
                          <span className="block truncate text-[12px] leading-snug text-muted">
                            {place.address}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-3 text-[13px] text-muted">No places matched “{q.trim()}”.</p>
            )}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
