"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import useSWR from "swr";
import { fetcher, keys } from "@/lib/api";
import type { MaskedSettings } from "@/lib/types";
import { Page } from "@/components/shell/Page";
import { Skeleton } from "@/components/ui/Misc";
import { IconChevronLeft } from "@/components/ui/icons";
import { findSection } from "@/components/settings/registry";

/** One settings section on its own page, reached from the Settings hub. */
export default function SettingsSectionPage() {
  const params = useParams<{ section: string }>();
  const router = useRouter();
  const section = findSection(params?.section ?? "");
  const { data: settings, isLoading, mutate } = useSWR<MaskedSettings>(keys.settings(), fetcher);

  useEffect(() => {
    if (!section) router.replace("/settings");
  }, [section, router]);

  if (!section) return null;

  return (
    <Page>
      <Link
        href="/settings"
        className="mb-3 inline-flex min-h-[36px] items-center gap-1 text-[13.5px] text-muted transition-colors hover:text-ink"
      >
        <IconChevronLeft className="h-4 w-4" /> Settings
      </Link>

      {isLoading || !settings ? (
        <Skeleton className="h-64 w-full rounded-2xl" />
      ) : (
        section.render(settings, mutate)
      )}
    </Page>
  );
}
