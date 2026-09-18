import type { ComponentType, SVGProps } from "react";
import type { FeatureSettings } from "@/lib/types";
import {
  IconCalendar,
  IconChart,
  IconChat,
  IconFolder,
  IconInbox,
  IconLink,
  IconLogbook,
  IconMapPin,
  IconNote,
  IconSliders,
  IconSun,
} from "@/components/ui/icons";

export interface NavItem {
  href: string;
  label: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/today", label: "Today", Icon: IconSun },
  { href: "/upcoming", label: "Upcoming", Icon: IconCalendar },
  { href: "/joint", label: "Ours", Icon: IconLink },
  { href: "/notes", label: "Notes", Icon: IconNote },
  { href: "/projects", label: "Projects", Icon: IconFolder },
  { href: "/inbox", label: "Inbox", Icon: IconInbox },
  { href: "/nearby", label: "Nearby", Icon: IconMapPin },
  { href: "/logbook", label: "Logbook", Icon: IconLogbook },
  { href: "/review", label: "Review", Icon: IconChart },
  { href: "/assistant", label: "Assistant", Icon: IconChat },
  { href: "/settings", label: "Settings", Icon: IconSliders },
];

/** The bottom bar's four fixed tabs — Ours earns one, so it is always a tap
 *  away; everything else (chat included) lives behind More. */
export const TAB_ITEMS: NavItem[] = ["/today", "/upcoming", "/joint", "/inbox"].map(
  (href) => NAV_ITEMS.find((i) => i.href === href)!,
);

export const MORE_ITEMS: NavItem[] = NAV_ITEMS.filter(
  (i) => !TAB_ITEMS.some((t) => t.href === i.href),
);

/** Pages that exist only while their feature is switched on. */
const OPTIONAL: Record<string, keyof FeatureSettings> = {
  "/assistant": "assistant",
  "/nearby": "nearby",
};

/**
 * The nav with switched-off corners removed. Defaults to showing everything,
 * so the shell renders sensibly in the moment before /me has answered.
 */
export function visibleItems(items: NavItem[], features?: FeatureSettings): NavItem[] {
  if (!features) return items;
  return items.filter((i) => {
    const flag = OPTIONAL[i.href];
    return flag === undefined || features[flag];
  });
}

/** Is this path one of the switched-off pages? */
export function isDisabledPath(pathname: string, features?: FeatureSettings): boolean {
  if (!features) return false;
  if (pathname.startsWith("/voice")) return !features.walkMode;
  const entry = Object.entries(OPTIONAL).find(([href]) => isActive(pathname, href));
  return entry ? !features[entry[1]] : false;
}

export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Wordmark({ className = "text-xl" }: { className?: string }) {
  return (
    <span className={`font-semibold tracking-tight ${className}`}>
      Done<span className="text-sunrise">X</span>
    </span>
  );
}
