"use client";

import { motion } from "framer-motion";
import type { ChatRole, ToolActivity } from "@/lib/types";
import { cn } from "@/lib/utils";
import { IconCheck, IconX } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/Button";

export interface ToolChipState {
  label: string;
  status: "start" | "ok" | "error";
}

export function toolChipsFromActivity(activity: ToolActivity[]): ToolChipState[] {
  return activity.map((a) => ({ label: a.label, status: a.ok ? "ok" : "error" }));
}

export function ToolChips({ tools }: { tools: ToolChipState[] }) {
  if (!tools.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {tools.map((t, i) => (
        <motion.span
          key={`${t.label}-${i}`}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11.5px] font-medium",
            t.status === "ok" && "border-stroke bg-sunken text-muted",
            t.status === "start" && "border-stroke bg-sunken text-faint",
            t.status === "error" && "border-danger/30 bg-danger/10 text-danger",
          )}
        >
          {t.status === "ok" ? (
            <IconCheck className="h-3 w-3 text-ok" strokeWidth={3} />
          ) : t.status === "error" ? (
            <IconX className="h-3 w-3" strokeWidth={3} />
          ) : (
            <Spinner className="h-2.5 w-2.5 border" />
          )}
          {t.label}
        </motion.span>
      ))}
    </div>
  );
}

export function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-1.5" aria-label="Assistant is thinking">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-accent animate-breathe"
          style={{ animationDelay: `${i * 180}ms` }}
        />
      ))}
    </span>
  );
}

export function ChatBubble({
  role,
  text,
  tools = [],
  pending,
  error,
}: {
  role: ChatRole;
  text: string;
  tools?: ToolChipState[];
  pending?: boolean;
  error?: string;
}) {
  const isUser = role === "user";
  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 36 }}
      className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
    >
      <div className={cn("max-w-[85%] sm:max-w-[75%]", isUser && "items-end")}>
        <div
          className={cn(
            "whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-[15px] leading-relaxed",
            isUser
              ? "rounded-br-md bg-accent-soft text-ink"
              : "rounded-bl-md border border-stroke bg-elev text-ink shadow-soft",
          )}
        >
          {text || (pending ? <TypingDots /> : null)}
        </div>
        {!isUser ? <ToolChips tools={tools} /> : null}
        {error ? (
          <p className="mt-1.5 rounded-xl border border-danger/30 bg-danger/10 px-2.5 py-1.5 text-[12.5px] text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </motion.div>
  );
}
