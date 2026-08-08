"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type { KeyedMutator } from "swr";
import { settingsApi, type SettingsPatch } from "@/lib/api";
import type { MaskedSettings, SecretMark } from "@/lib/types";
import { cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/Button";
import { IconCheck, IconCopy } from "@/components/ui/icons";
import { useToast } from "@/components/ui/Toast";

export interface SectionProps {
  settings: MaskedSettings;
  mutate: KeyedMutator<MaskedSettings>;
}

export function SettingsCard({
  id,
  title,
  description,
  children,
  actions,
}: {
  id?: string;
  title: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section id={id} className="card scroll-mt-6 p-5">
      <div className="mb-4 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold tracking-tight text-ink">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-[13px] leading-relaxed text-muted">{description}</p>
          ) : null}
        </div>
        {actions}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export function Divider() {
  return <div className="h-px bg-stroke" />;
}

export function maskPlaceholder(mark: SecretMark | undefined, fallback = "Not set"): string {
  if (mark?.set) return `••••${mark.last4}`;
  return fallback;
}

export function useSettingsPatch(mutate: KeyedMutator<MaskedSettings>) {
  const toast = useToast();
  return async (patch: SettingsPatch, successMessage?: string): Promise<boolean> => {
    try {
      const next = await settingsApi.patch(patch);
      await mutate(next, { revalidate: false });
      if (successMessage) toast.success(successMessage);
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save settings");
      return false;
    }
  };
}

export function CopyField({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const toast = useToast();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Copy failed — select the text manually");
    }
  };

  return (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-muted">{label}</div>
      <div className="flex items-center gap-2 rounded-2xl border border-stroke bg-sunken px-3 py-2.5">
        <code
          className={cn(
            "min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[12.5px] text-ink",
            mono && "font-mono",
          )}
        >
          {value}
        </code>
        <IconButton label={`Copy ${label}`} size="sm" onClick={copy}>
          {copied ? <IconCheck className="h-4 w-4 text-ok" /> : <IconCopy className="h-4 w-4" />}
        </IconButton>
      </div>
    </div>
  );
}

export function Accordion({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="overflow-hidden rounded-2xl border border-stroke">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-[46px] w-full items-center gap-2 bg-sunken px-3.5 text-left text-[14px] font-medium text-ink"
      >
        <span className="flex-1">{title}</span>
        <span className={cn("text-faint transition-transform", open && "rotate-90")}>›</span>
      </button>
      {open ? <div className="space-y-3 px-3.5 py-3.5 text-[13.5px] leading-relaxed text-muted">{children}</div> : null}
    </div>
  );
}

export function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5">
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">
            {i + 1}
          </span>
          <span className="min-w-0 flex-1">{item}</span>
        </li>
      ))}
    </ol>
  );
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="block overflow-x-auto whitespace-pre rounded-xl border border-stroke bg-sunken px-3 py-2.5 font-mono text-[12px] text-ink">
      {children}
    </code>
  );
}
