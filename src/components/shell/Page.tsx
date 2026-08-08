import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const WIDTH = {
  md: "max-w-xl",
  lg: "max-w-2xl",
  xl: "max-w-3xl",
  wide: "max-w-5xl",
} as const;

export function Page({
  children,
  width = "lg",
  className,
}: {
  children: ReactNode;
  width?: keyof typeof WIDTH;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-4 pb-32 pt-5 sm:px-6 lg:pb-16 lg:pt-10",
        WIDTH[width],
        className,
      )}
    >
      {children}
    </div>
  );
}
