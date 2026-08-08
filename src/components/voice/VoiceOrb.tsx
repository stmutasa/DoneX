"use client";

import { AnimatePresence, motion } from "framer-motion";
import type { VoicePhase } from "@/hooks/useVoiceConversation";

const CONIC =
  "conic-gradient(from 0deg, transparent 0deg, var(--grad-a) 110deg, var(--grad-b) 210deg, transparent 320deg)";
const RING_MASK =
  "radial-gradient(farthest-side, transparent calc(100% - 3px), black calc(100% - 3px))";

export function VoiceOrb({
  phase,
  micLevel,
  onTap,
  label,
}: {
  phase: VoicePhase;
  micLevel: number;
  onTap: () => void;
  label: string;
}) {
  const listening = phase === "listening";
  const speaking = phase === "speaking";
  const thinking = phase === "thinking";
  const level = Math.min(1, micLevel);

  return (
    <button
      type="button"
      onClick={onTap}
      aria-label={label}
      className="relative grid h-[248px] w-[248px] shrink-0 place-items-center rounded-full outline-none"
    >
      <motion.span
        aria-hidden="true"
        className="absolute h-[180px] w-[180px] rounded-full bg-sunrise blur-[56px]"
        animate={{
          opacity: listening ? 0.5 + level * 0.4 : speaking ? 0.7 : thinking ? 0.5 : 0.42,
          scale: listening ? 1 + level * 0.3 : speaking ? 1.12 : 1,
        }}
        transition={{ type: "spring", stiffness: 220, damping: 22 }}
      />

      <AnimatePresence>
        {speaking
          ? [0, 1, 2].map((i) => (
              <motion.span
                key={`ripple-${i}`}
                aria-hidden="true"
                className="absolute h-[180px] w-[180px] rounded-full border border-accent"
                initial={{ scale: 1, opacity: 0.45 }}
                animate={{ scale: 1.75, opacity: 0 }}
                exit={{ opacity: 0 }}
                transition={{ repeat: Infinity, duration: 2.2, delay: i * 0.72, ease: "easeOut" }}
              />
            ))
          : null}
      </AnimatePresence>

      <AnimatePresence>
        {thinking ? (
          <motion.span
            aria-hidden="true"
            className="absolute h-[206px] w-[206px] rounded-full"
            style={{
              background: CONIC,
              WebkitMaskImage: RING_MASK,
              maskImage: RING_MASK,
            }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.95, rotate: 360 }}
            exit={{ opacity: 0 }}
            transition={{
              rotate: { repeat: Infinity, duration: 2.6, ease: "linear" },
              opacity: { duration: 0.3 },
            }}
          />
        ) : null}
      </AnimatePresence>

      <motion.span
        aria-hidden="true"
        className="relative h-[180px] w-[180px] rounded-full bg-sunrise"
        style={{ boxShadow: "0 0 60px var(--accent-glow), inset 0 -18px 40px var(--accent-glow)" }}
        animate={
          listening
            ? { scale: 1 + level * 0.14 }
            : speaking
              ? { scale: [1, 1.035, 1] }
              : thinking
                ? { scale: [1, 1.02, 1] }
                : { scale: [1, 1.045, 1] }
        }
        transition={
          listening
            ? { type: "spring", stiffness: 320, damping: 18 }
            : {
                repeat: Infinity,
                duration: speaking ? 1.1 : thinking ? 2 : 3.8,
                ease: "easeInOut",
              }
        }
      />
    </button>
  );
}
