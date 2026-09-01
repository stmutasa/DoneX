"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import useSWR from "swr";
import { motion } from "framer-motion";
import { authApi, fetcher, keys } from "@/lib/api";
import type { InboxItem, StatsSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { CountBadge } from "@/components/ui/Misc";
import { Sheet } from "@/components/ui/Sheet";
import { Segmented } from "@/components/ui/Segmented";
import {
  IconChat,
  IconLogout,
  IconMonitor,
  IconMoon,
  IconMore,
  IconPlus,
  IconSun,
} from "@/components/ui/icons";
import { QuickAddSheet } from "@/components/tasks/QuickAdd";
import { MORE_ITEMS, NAV_ITEMS, TAB_ITEMS, Wordmark, isActive } from "./nav";
import { OfflineBanner } from "./OfflineBanner";
import { useTheme } from "./ThemeProvider";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [moreOpen, setMoreOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);

  const { data: me } = useSWR<{ role: "owner" | "partner" }>(keys.me(), fetcher);
  const partner = me?.role === "partner";
  // Owner-only fetches wait until the role is actually known.
  const owner = me?.role === "owner";

  const { data: inbox } = useSWR<{ items: InboxItem[]; newCount: number }>(
    owner ? keys.inbox("new") : null,
    fetcher,
    { refreshInterval: 180_000 },
  );
  const { data: stats } = useSWR<StatsSummary>(owner ? keys.stats() : null, fetcher);

  // A partner session lives on the joint tab; everything else redirects there.
  useEffect(() => {
    if (partner && !pathname.startsWith("/joint")) router.replace("/joint");
  }, [partner, pathname, router]);

  const newCount = inbox?.newCount ?? 0;
  const streak = stats?.streakDays ?? 0;
  const hideFab =
    partner || pathname.startsWith("/assistant") || pathname.startsWith("/voice");

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

  const signOut = async () => {
    try {
      await authApi.logout();
    } catch {
      /* signing out locally regardless */
    }
    window.location.href = "/login";
  };

  if (partner) {
    return (
      <div className="min-h-dvh bg-bg">
        <OfflineBanner />
        <PartnerTopBar onSignOut={signOut} />
        <main className="pb-24 lg:pb-0">{children}</main>
        <PartnerBar onSignOut={signOut} />
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-bg">
      <OfflineBanner />
      <DesktopSidebar
        pathname={pathname}
        newCount={newCount}
        streak={streak}
        onQuickAdd={() => setQuickOpen(true)}
        onSignOut={signOut}
      />

      <main className="lg:pl-[248px]">{children}</main>

      <MobileTabBar pathname={pathname} onMore={() => setMoreOpen(true)} inboxBadge={newCount} />

      {!hideFab ? (
        <button
          type="button"
          onClick={() => setQuickOpen(true)}
          aria-label="Quick add task"
          className="fixed right-4 z-40 grid h-14 w-14 place-items-center rounded-full bg-sunrise text-on-accent shadow-lift transition-transform active:scale-95 bottom-[calc(env(safe-area-inset-bottom,0px)+84px)] lg:hidden"
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
  onSignOut,
}: {
  pathname: string;
  newCount: number;
  streak: number;
  onQuickAdd: () => void;
  onSignOut: () => void;
}) {
  const { theme, setTheme } = useTheme();
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

      {/* Theme and sign-out live in the phone's More sheet; on a desktop the
          sidebar is where you'd go looking for them. */}
      <div className="mt-3 flex items-center gap-1 border-t border-stroke pt-3">
        <ThemeCycleButton theme={theme} setTheme={setTheme} />
        <span className="flex-1" />
        <button
          type="button"
          onClick={onSignOut}
          className="flex min-h-[36px] items-center gap-2 rounded-xl px-2.5 text-[13px] text-muted transition-colors hover:bg-sunken hover:text-ink"
        >
          <IconLogout className="h-4 w-4" />
          Sign out
        </button>
      </div>
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
  const moreActive = MORE_ITEMS.some((i) => isActive(pathname, i.href));

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-stroke bg-elev/92 backdrop-blur-xl lg:hidden">
      <div className="mx-auto flex max-w-md items-stretch justify-around px-1 pb-safe">
        {TAB_ITEMS.map((item) => (
          <Tab
            key={item.href}
            item={item}
            pathname={pathname}
            badge={item.href === "/inbox" ? inboxBadge : 0}
          />
        ))}

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

function PartnerBar({ onSignOut }: { onSignOut: () => void }) {
  const { theme, setTheme } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-stroke bg-elev/92 backdrop-blur-xl lg:hidden">
      <div className="mx-auto flex max-w-md items-center justify-between px-6 py-2.5 pb-safe">
        <span className="text-[13px] font-semibold tracking-tight text-ink">
          Done<span className="text-sunrise">X</span>
          <span className="ml-2 font-normal text-muted">shared list</span>
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTheme(next)}
            aria-label="Switch theme"
            className="grid h-10 w-10 place-items-center rounded-full text-muted transition-colors hover:text-ink"
          >
            {theme === "dark" ? <IconSun className="h-5 w-5" /> : <IconMoon className="h-5 w-5" />}
          </button>
          <button
            type="button"
            onClick={onSignOut}
            className="min-h-[40px] rounded-full px-3 text-[13px] font-medium text-muted transition-colors hover:text-ink"
          >
            Sign out
          </button>
        </div>
      </div>
    </nav>
  );
}

/** Cycles system → light → dark, labelled for whichever is active. */
function ThemeCycleButton({
  theme,
  setTheme,
}: {
  theme: "system" | "light" | "dark";
  setTheme: (t: "system" | "light" | "dark") => void;
}) {
  const next = theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const Icon = theme === "light" ? IconSun : theme === "dark" ? IconMoon : IconMonitor;
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Theme: ${theme}. Switch to ${next}`}
      title={`Theme: ${theme}`}
      className="flex min-h-[36px] items-center gap-2 rounded-xl px-2.5 text-[13px] capitalize text-muted transition-colors hover:bg-sunken hover:text-ink"
    >
      <Icon className="h-4 w-4" />
      {theme}
    </button>
  );
}

/** The partner's desktop chrome: one destination, so a top bar rather than a
 *  sidebar — the phone keeps its bottom bar. */
function PartnerTopBar({ onSignOut }: { onSignOut: () => void }) {
  const { theme, setTheme } = useTheme();
  return (
    <header className="sticky top-0 z-30 hidden border-b border-stroke bg-elev/92 backdrop-blur-xl lg:block">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-6">
        <Wordmark className="text-[19px]" />
        <span className="text-[14px] text-muted">shared list</span>
        <span className="flex-1" />
        <ThemeCycleButton theme={theme} setTheme={setTheme} />
        <button
          type="button"
          onClick={onSignOut}
          className="flex min-h-[36px] items-center gap-2 rounded-xl px-2.5 text-[13px] text-muted transition-colors hover:bg-sunken hover:text-ink"
        >
          <IconLogout className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </header>
  );
}
