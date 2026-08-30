"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { Project, Task } from "@/lib/types";
import { cn } from "@/lib/utils";
import { IconChevronDown } from "@/components/ui/icons";
import { TaskItem } from "./TaskItem";

export function TaskList({
  tasks,
  projects,
  onOpen,
  showProject = true,
  attribution,
  className,
}: {
  tasks: Task[];
  projects: Project[];
  onOpen?: (task: Task) => void;
  showProject?: boolean;
  /** joint list: show who added each task, tinted with their chosen color */
  attribution?: { owner: string; partner: string; colors?: { owner?: string; partner?: string } };
  className?: string;
}) {
  const byId = new Map(projects.map((p) => [p.id, p]));
  return (
    <ul className={cn("space-y-2 lg:space-y-1.5", className)}>
      <AnimatePresence initial={false} mode="popLayout">
        {tasks.map((task) => (
          <motion.li
            key={task.id}
            layout
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.15 } }}
            transition={{ type: "spring", stiffness: 460, damping: 40 }}
          >
            <TaskItem
              task={task}
              project={task.projectId ? byId.get(task.projectId) : undefined}
              onOpen={onOpen}
              showProject={showProject}
              attribution={attribution}
            />
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}

export function TaskGroup({
  title,
  count,
  tone = "default",
  collapsible = false,
  defaultCollapsed = false,
  children,
  action,
  className,
}: {
  title: string;
  count?: number;
  tone?: "default" | "danger" | "muted";
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const Heading = collapsible ? "button" : "div";

  return (
    <section className={cn("mb-6", className)}>
      <Heading
        {...(collapsible
          ? {
              type: "button" as const,
              onClick: () => setCollapsed((c) => !c),
              "aria-expanded": !collapsed,
            }
          : {})}
        className={cn(
          "mb-2 flex w-full items-center gap-2 px-1 text-left",
          collapsible && "min-h-[32px]",
        )}
      >
        <h2
          className={cn(
            "text-[12px] font-semibold uppercase tracking-[0.08em]",
            tone === "danger" ? "text-danger" : tone === "muted" ? "text-faint" : "text-muted",
          )}
        >
          {title}
        </h2>
        {typeof count === "number" ? (
          <span className="text-[12px] font-medium text-faint">{count}</span>
        ) : null}
        {collapsible ? (
          <IconChevronDown
            className={cn(
              "h-3.5 w-3.5 text-faint transition-transform",
              collapsed && "-rotate-90",
            )}
          />
        ) : null}
        <span className="flex-1" />
        {action}
      </Heading>
      <AnimatePresence initial={false}>
        {!collapsed ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
