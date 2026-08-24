"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { fetcher, keys } from "@/lib/api";
import type { GoogleStatus, MaskedSettings } from "@/lib/types";
import { Page } from "@/components/shell/Page";
import { PageHeader, Skeleton } from "@/components/ui/Misc";
import { IconChevronRight } from "@/components/ui/icons";
import { SETTINGS_GROUPS, findSection } from "@/components/settings/registry";

/** Settings hub: grouped menu rows with live status, one sub-page per row. */
export default function SettingsPage() {
  const router = useRouter();
  const { data: settings, isLoading } = useSWR<MaskedSettings>(keys.settings(), fetcher);
  const { data: google } = useSWR<GoogleStatus>(keys.googleStatus(), fetcher);

  // Legacy deep links (/settings#ai from old buttons, bookmarks, docs) land
  // on the matching sub-page.
  useEffect(() => {
    const slug = window.location.hash.slice(1);
    if (slug && findSection(slug)) router.replace(`/settings/${slug}`);
  }, [router]);

  return (
    <Page>
      <PageHeader title="Settings" subtitle="Make DoneX yours." />

      {isLoading || !settings ? (
        <div className="space-y-4">
          {["h-44", "h-44", "h-44", "h-32"].map((h, i) => (
            <Skeleton key={i} className={`w-full rounded-2xl ${h}`} />
          ))}
        </div>
      ) : (
        <div className="space-y-5">
          {SETTINGS_GROUPS.map((group) => (
            <section key={group.label}>
              <p className="mb-1.5 px-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">
                {group.label}
              </p>
              <div className="overflow-hidden rounded-2xl border border-stroke bg-elev">
                {group.sections.map(({ slug, title, icon: Icon, subtitle }, i) => (
                  <Link
                    key={slug}
                    href={`/settings/${slug}`}
                    className={`flex min-h-[60px] items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-sunken ${i > 0 ? "border-t border-stroke" : ""}`}
                  >
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
                      <Icon className="h-[18px] w-[18px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-medium text-ink">{title}</span>
                      <span className="block truncate text-[12.5px] text-muted">
                        {subtitle(settings, google)}
                      </span>
                    </span>
                    <IconChevronRight className="h-4 w-4 shrink-0 text-faint" />
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </Page>
  );
}
