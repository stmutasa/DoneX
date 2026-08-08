import type { ComponentType, SVGProps } from "react";
import {
  IconCalendar,
  IconChart,
  IconChat,
  IconFolder,
  IconInbox,
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
  { href: "/assistant", label: "Assistant", Icon: IconChat },
  { href: "/notes", label: "Notes", Icon: IconNote },
  { href: "/projects", label: "Projects", Icon: IconFolder },
  { href: "/inbox", label: "Inbox", Icon: IconInbox },
  { href: "/review", label: "Review", Icon: IconChart },
  { href: "/settings", label: "Settings", Icon: IconSliders },
];

export const MORE_ITEMS: NavItem[] = NAV_ITEMS.filter((i) =>
  ["/projects", "/inbox", "/review", "/settings"].includes(i.href),
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
