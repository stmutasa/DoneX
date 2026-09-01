import type { ComponentType, SVGProps } from "react";
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
