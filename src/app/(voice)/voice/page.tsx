"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { AnimatePresence, motion } from "framer-motion";
import { fetcher, keys, locationApi, settingsApi } from "@/lib/api";
import type { MaskedSettings } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useVoiceConversation } from "@/hooks/useVoiceConversation";
import { useWakeLock } from "@/hooks/useWakeLock";
import { useToast } from "@/components/ui/Toast";
import { Button, IconButton } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Field";
import { IconKeyboard, IconSend, IconX } from "@/components/ui/icons";
import { VoiceOrb } from "@/components/voice/VoiceOrb";

const STORAGE_KEY = "donex-conversation";

const PHASE_LABEL: Record<string, string> = {
  idle: "Tap to talk",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking — tap to interrupt",
};

export default function VoicePage() {
  const router = useRouter();
  const toast = useToast();

  const { data: settings, mutate: mutateSettings } = useSWR<MaskedSettings>(
    keys.settings(),
    fetcher,
  );

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const [autoListen, setAutoListen] = useState(false);
  const [showText, setShowText] = useState(false);
  const [textDraft, setTextDraft] = useState("");
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    try {
      setConversationId(localStorage.getItem(STORAGE_KEY));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (settings) setAutoListen(settings.voice.autoListen);
  }, [settings]);

  // One fix per session — walk mode keeps working if it's denied or times out.
  useEffect(() => {
    if (!active || coords) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    let cancelled = false;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (cancelled) return;
        const next = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setCoords(next);
        void locationApi.report(next.lat, next.lng).catch(() => {});
      },
      () => {},
      { timeout: 8000, maximumAge: 300_000 },
    );
    return () => {
      cancelled = true;
    };
  }, [active, coords]);

  const voice = useVoiceConversation({
    conversationId,
    autoListen,
    voiceURI: settings?.voice.voiceURI || undefined,
    rate: settings?.voice.rate ?? 1,
    location: coords,
    onConversationId: (id) => {
      setConversationId(id);
      try {
        localStorage.setItem(STORAGE_KEY, id);
      } catch {
        /* ignore */
      }
    },
    onError: (message) => toast.error(message),
  });

  useWakeLock(active);

  const recent = useMemo(() => voice.turns.slice(-5, -1), [voice.turns]);

  const toggleAutoListen = async (next: boolean) => {
    setAutoListen(next);
    try {
      const updated = await settingsApi.patch({ voice: { autoListen: next } });
      await mutateSettings(updated, { revalidate: false });
    } catch {
      toast.error("Couldn’t save hands-free setting");
    }
  };

  const onTap = () => {
    if (voice.phase === "speaking") {
      setActive(true);
      voice.interrupt();
      return;
    }
    if (voice.phase === "idle") {
      setActive(true);
      voice.start();
      return;
    }
    setActive(false);
    voice.stop();
  };

  const close = () => {
    voice.stop();
    setActive(false);
    router.push("/assistant");
  };

  const sendText = () => {
    const text = textDraft.trim();
    if (!text) return;
    setTextDraft("");
    setActive(true);
    voice.sendText(text);
  };

  return (
    <div data-theme="dark" className="relative flex h-[100dvh] flex-col overflow-hidden bg-bg text-ink">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-32 left-1/2 h-[380px] w-[380px] -translate-x-1/2 rounded-full bg-sunrise opacity-[0.10] blur-[120px]"
      />

      <header className="relative z-10 flex shrink-0 items-center justify-between px-4 pb-3 pt-[calc(0.75rem+env(safe-area-inset-top,0px))]">
        <span className="text-[13px] font-medium uppercase tracking-[0.14em] text-faint">
          Walk mode
        </span>
        <IconButton label="Close walk mode" onClick={close}>
          <IconX className="h-5 w-5" />
        </IconButton>
      </header>

      <main className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-between px-5 pb-4">
        <div className="flex w-full max-w-md flex-1 flex-col justify-end gap-3 overflow-hidden pb-4 pt-2">
          {recent.length ? (
            <div className="space-y-1.5">
              {recent.map((turn, i) => (
                <p
                  key={turn.id}
                  className={cn(
                    "truncate text-[13px] leading-relaxed",
                    turn.role === "user" ? "text-faint" : "text-muted",
                  )}
                  style={{ opacity: 0.35 + i * 0.15 }}
                >
                  {turn.role === "user" ? "You: " : "DoneX: "}
                  {turn.text}
                </p>
              ))}
            </div>
          ) : null}

          <AnimatePresence mode="wait">
            {voice.lastReply ? (
              <motion.p
                key="reply"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="max-h-[34dvh] overflow-y-auto text-center text-[17px] leading-relaxed text-ink"
              >
                {voice.lastReply}
              </motion.p>
            ) : !voice.turns.length ? (
              <motion.p
                key="hint"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-center text-[15px] leading-relaxed text-muted"
              >
                Pop in your headphones and start walking.
                <br />
                Ask about your day, add tasks, think out loud.
              </motion.p>
            ) : null}
          </AnimatePresence>
        </div>

        {!voice.supported ? (
          <div className="w-full max-w-sm rounded-2xl border border-stroke bg-elev p-4 text-center">
            <p className="text-[15px] font-medium text-ink">Voice input isn’t available here</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              This browser doesn’t support speech recognition. Chrome on Android works great — or
              type below and DoneX will still answer out loud.
            </p>
          </div>
        ) : voice.micError === "denied" ? (
          <div className="w-full max-w-sm rounded-2xl border border-stroke bg-elev p-4 text-center">
            <p className="text-[15px] font-medium text-ink">Microphone blocked</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              Allow microphone access for this site (tap the lock icon in the address bar), then
              reload. You can also type instead.
            </p>
          </div>
        ) : (
          <VoiceOrb
            phase={voice.phase}
            micLevel={voice.micLevel}
            onTap={onTap}
            label={PHASE_LABEL[voice.phase]}
          />
        )}

        <div className="flex w-full max-w-md flex-col items-center gap-2 pt-5">
          <p className="text-[14px] font-medium text-muted">{PHASE_LABEL[voice.phase]}</p>
          <p
            className={cn(
              "min-h-[22px] text-center text-[15px] transition-colors",
              voice.interim ? "text-ink" : "text-faint",
            )}
          >
            {voice.interim}
          </p>
        </div>
      </main>

      <footer className="relative z-10 shrink-0 px-5 pb-safe">
        <AnimatePresence>
          {showText ? (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              className="mb-3 flex items-end gap-2"
            >
              <input
                value={textDraft}
                autoFocus
                onChange={(e) => setTextDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendText()}
                placeholder="Type instead…"
                enterKeyHint="send"
                className="h-11 flex-1 rounded-2xl border border-stroke bg-sunken px-3.5 text-[15px] text-ink outline-none placeholder:text-faint"
              />
              <button
                type="button"
                aria-label="Send"
                onClick={sendText}
                disabled={!textDraft.trim()}
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-sunrise text-on-accent disabled:opacity-40"
              >
                <IconSend className="h-[18px] w-[18px]" />
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className="flex items-center justify-between gap-3 pb-4">
          <label className="flex items-center gap-2.5 rounded-full border border-stroke bg-elev px-3 py-2 text-[13px] text-muted">
            Hands-free
            <Switch label="Hands-free" checked={autoListen} onChange={toggleAutoListen} />
          </label>

          <div className="flex items-center gap-2">
            {voice.phase !== "idle" ? (
              <Button size="sm" onClick={() => { setActive(false); voice.stop(); }}>
                Stop
              </Button>
            ) : null}
            <IconButton
              label="Type a message"
              active={showText}
              onClick={() => setShowText((s) => !s)}
            >
              <IconKeyboard className="h-5 w-5" />
            </IconButton>
          </div>
        </div>
      </footer>
    </div>
  );
}
