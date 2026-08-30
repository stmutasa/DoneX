import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Page frame. Phone-first, but a desktop window is not a tall phone: the
 * column widens past `lg`, and pages with a secondary column pass `aside` to
 * get a proper right rail.
 *
 * The rail is one grid — never a second copy of the content — so on narrow
 * screens its children simply stack with the main column. `asideLeads` puts
 * them above the main column there (the morning briefing wants that) while
 * still sitting in the rail on a wide screen.
 */
const WIDTH = {
  md: "max-w-xl lg:max-w-3xl",
  lg: "max-w-2xl lg:max-w-4xl",
  xl: "max-w-3xl lg:max-w-5xl",
  wide: "max-w-5xl lg:max-w-6xl",
} as const;

const FRAME = "mx-auto w-full px-4 pb-32 pt-5 sm:px-6 lg:pb-16 lg:pt-10";

export function Page({
  children,
  width = "lg",
  aside,
  asideLeads = false,
  className,
}: {
  children: ReactNode;
  width?: keyof typeof WIDTH;
  /** secondary column: a right rail on wide screens, stacked below on narrow */
  aside?: ReactNode;
  /** on narrow screens, put the aside above the main column */
  asideLeads?: boolean;
  className?: string;
}) {
  if (!aside) {
    return <div className={cn(FRAME, WIDTH[width], className)}>{children}</div>;
  }

  return (
    <div className={cn(FRAME, "max-w-2xl lg:max-w-6xl")}>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px] xl:gap-8">
        <div className={cn("min-w-0", className)}>{children}</div>
        <aside
          className={cn(
            "min-w-0 space-y-3",
            asideLeads && "order-first xl:order-none",
            "xl:sticky xl:top-10 xl:self-start",
          )}
        >
          {aside}
        </aside>
      </div>
    </div>
  );
}
