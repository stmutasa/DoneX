"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import { motion } from "framer-motion";
import { fetcher, keys } from "@/lib/api";
import type { InboxItem, StatsSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { CountBadge } from "@/components/ui/Misc";
import { Sheet } from "@/components/ui/Sheet";
import { Segmented } from "@/components/ui/Segmented";
import {
  IconChat,
  IconMonitor,
  IconMoon,
  IconMore,
  IconPlus,
  IconSun,
} from "@/components/ui/icons";
import { QuickAddSheet } from "@/components/tasks/QuickAdd";
import { MORE_ITEMS, NAV_ITEMS, Wordmark, isActive } from "./nav";
import { OfflineBanner } from "./OfflineBanner";
import { useTheme } from "./ThemeProvider";

const TAB_ORDER = ["/today", "/upcoming", "/inbox"];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);

  const { data: inbox } = useSWR<{ items: InboxItem[]; newCount: number }>(
    keys.inbox("new"),
    fetcher,
    { refreshInterval: 180_000 },
  );
  const { data: stats } = useSWR<StatsSummary>(keys.stats(), fetcher);

  const newCount = inbox?.newCount ?? 0;
  const streak = stats?.streakDays ?? 0;
  const hideFab = pathname.startsWith("/assistant") || pathname.startsWith("/voice");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("quick") === "1") {
      setQuickOpen(true);
      params.delete("quick");
      const q = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${q ? `?${q}` : ""}`);
    }
  }, []);

  useEffect(() => setMoreOpen(false), [pathname]);

  return (
    <div className="min-h-dvh bg-bg">
      <OfflineBanner />
      <DesktopSidebar pathname={pathname} newCount={newCount} streak={streak} onQuickAdd={() => setQuickOpen(true)} />

      <main className="lg:pl-[248px]">{children}</main>

      <MobileTabBar pathname={pathname} onMore={() => setMoreOpen(true)} inboxBadge={newCount} />

      {!hideFab ? (
        <button
          type="button"
          onClick={() => setQuickOpen(true)}
          aria-label="Quick add task"
          className="fixed right-4 z-40 grid h-14 w-14 place-items-center rounded-full bg-sunrise text-on-accent shadow-lift transition-transform active:scale-95 bottom-[calc(env(safe-area-inset-bottom,0px)+84px)] lg:bottom-8 lg:right-8"
        >
          <IconPlus className="h-6 w-6" strokeWidth={2.2} />
        </button>
      ) : null}

      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} pathname={pathname} newCount={newCount} />
      <QuickAddSheet open={quickOpen} onClose={() => setQuickOpen(false)} />
    </div>
  );
}

function DesktopSidebar({
  pathname,
  newCount,
  streak,
  onQuickAdd,
}: {
  pathname: string;
  newCount: number;
  streak: number;
  onQuickAdd: () => void;
}) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-stroke bg-elev px-3 py-5 lg:flex">
      <div className="flex items-center justify-between px-2 pb-5">
        <Link href="/today" className="rounded-lg">
          <Wordmark className="text-[22px]" />
        </Link>
        {streak >= 2 ? (
          <span className="rounded-full bg-accent-soft px-2 py-1 text-[12px] font-medium text-accent">
            🔥 {streak}
          </span>
        ) : null}
      </div>

      <Button variant="primary" size="md" className="mb-4" block icon={<IconPlus className="h-[18px] w-[18px]" />} onClick={onQuickAdd}>
        New task
      </Button>

      <nav className="flex-1 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map(({ href, label, Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "relative flex min-h-[44px] items-center gap-3 rounded-2xl px-3 text-[15px] transition-colors",
                active ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-sunken hover:text-ink",
              )}
            >
              {active ? (
                <motion.span
                  layoutId="sidebar-active"
                  className="absolute left-0 h-6 w-[3px] rounded-full bg-sunrise"
                  transition={{ type: "spring", stiffness: 500, damping: 40 }}
                />
              ) : null}
              <Icon className="h-[19px] w-[19px]" />
              <span className="flex-1">{label}</span>
              {href === "/inbox" ? <CountBadge count={newCount} /> : null}
            </Link>
          );
        })}
      </nav>

      <Link
        href="/voice"
        className="mt-3 flex min-h-[44px] items-center gap-3 rounded-2xl border border-stroke px-3 text-[14px] text-muted transition-colors hover:text-ink"
      >
        <span className="grid h-6 w-6 place-items-center rounded-full bg-sunrise text-on-accent">
          <IconChat className="h-3.5 w-3.5" />
        </span>
        Walk mode
      </Link>
    </aside>
  );
}

function MobileTabBar({
  pathname,
  onMore,
  inboxBadge,
}: {
  pathname: string;
  onMore: () => void;
  inboxBadge: number;
}) {
  const byHref = new Map(NAV_ITEMS.map((i) => [i.href, i]));
  const [today, upcoming, inbox] = TAB_ORDER.map((href) => byHref.get(href)!);
  const moreActive = MORE_ITEMS.some((i) => isActive(pathname, i.href));

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-stroke bg-elev/92 backdrop-blur-xl lg:hidden">
      <div className="mx-auto flex max-w-md items-stretch justify-around px-1 pb-safe">
        <Tab item={today} pathname={pathname} />
        <Tab item={upcoming} pathname={pathname} />

        <div className="relative flex w-[68px] shrink-0 justify-center">
          <Link
            href="/assistant"
            aria-label="Assistant"
            className={cn(
              "absolute -top-5 grid h-14 w-14 place-items-center rounded-full bg-sunrise text-on-accent shadow-lift transition-transform active:scale-95",
              isActive(pathname, "/assistant") && "ring-4 ring-accent-soft",
            )}
          >
            <IconChat className="h-6 w-6" />
          </Link>
        </div>

        <Tab item={inbox} pathname={pathname} badge={inboxBadge} />

        <button
          type="button"
          onClick={onMore}
          aria-label="More"
          className={cn(
            "relative flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 pt-2 text-[10.5px] font-medium transition-colors",
            moreActive ? "text-accent" : "text-faint",
          )}
        >
          {moreActive ? (
            <motion.span
              layoutId="tab-active"
              className="absolute top-0 h-[3px] w-8 rounded-full bg-sunrise"
              transition={{ type: "spring", stiffness: 500, damping: 40 }}
            />
          ) : null}
          <IconMore className="h-[21px] w-[21px]" />
          More
        </button>
      </div>
    </nav>
  );
}

function Tab({
  item,
  pathname,
  badge = 0,
}: {
  item: (typeof NAV_ITEMS)[number];
  pathname: string;
  badge?: number;
}) {
  const active = isActive(pathname, item.href);
  const { Icon } = item;
  return (
    <Link
      href={item.href}
      className={cn(
        "relative flex min-h-[56px] flex-1 flex-col items-center justify-center gap-1 pt-2 text-[10.5px] font-medium transition-colors",
        active ? "text-accent" : "text-faint",
      )}
    >
      {active ? (
        <motion.span
          layoutId="tab-active"
          className="absolute top-0 h-[3px] w-8 rounded-full bg-sunrise"
          transition={{ type: "spring", stiffness: 500, damping: 40 }}
        />
      ) : null}
      <span className="relative">
        <Icon className="h-[21px] w-[21px]" />
        {badge > 0 ? (
          <span className="absolute -right-2 -top-1.5 grid min-w-[16px] place-items-center rounded-full bg-sunrise px-1 text-[10px] font-semibold leading-[16px] text-on-accent">
            {badge > 9 ? "9+" : badge}
          </span>
        ) : null}
      </span>
      {item.label}
    </Link>
  );
}

function MoreSheet({
  open,
  onClose,
  pathname,
  newCount,
}: {
  open: boolean;
  onClose: () => void;
  pathname: string;
  newCount: number;
}) {
  const { theme, setTheme } = useTheme();
  return (
    <Sheet open={open} onClose={onClose} title="More">
      <div className="space-y-1 pb-2">
        {MORE_ITEMS.map(({ href, label, Icon }) => (
          <Link
            key={href}
            href={href}
            onClick={onClose}
            className={cn(
              "flex min-h-[52px] items-center gap-3 rounded-2xl px-3 text-[15px] transition-colors",
              isActive(pathname, href) ? "bg-accent-soft text-accent" : "text-ink hover:bg-sunken",
            )}
          >
            <Icon className="h-5 w-5" />
            <span className="flex-1">{label}</span>
            {href === "/inbox" ? <CountBadge count={newCount} /> : null}
          </Link>
        ))}
        <Link
          href="/voice"
          onClick={onClose}
          className="flex min-h-[52px] items-center gap-3 rounded-2xl px-3 text-[15px] text-ink transition-colors hover:bg-sunken"
        >
          <span className="grid h-5 w-5 place-items-center rounded-full bg-sunrise text-on-accent">
            <IconChat className="h-3 w-3" />
          </span>
          <span className="flex-1">Walk mode</span>
        </Link>
      </div>

      <div className="mt-3 border-t border-stroke pt-4">
        <p className="mb-2 px-1 text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">
          Appearance
        </p>
        <Segmented
          ariaLabel="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: "system", label: "System", icon: <IconMonitor className="h-4 w-4" /> },
            { value: "light", label: "Light", icon: <IconSun className="h-4 w-4" /> },
            { value: "dark", label: "Dark", icon: <IconMoon className="h-4 w-4" /> },
          ]}
        />
      </div>
    </Sheet>
  );
}
