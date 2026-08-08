"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface SpeakOptions {
  voiceURI?: string;
  rate?: number;
  onAllEnd?: () => void;
}

export interface TTSApi {
  supported: boolean;
  speaking: boolean;
  voices: SpeechSynthesisVoice[];
  speak: (text: string, opts?: SpeakOptions) => void;
  cancel: () => void;
}

/** Split into utterance-sized chunks so mobile Chrome doesn't truncate. */
export function chunkForSpeech(text: string, max = 180): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const sentences = clean.match(/[^.!?…]+[.!?…]*\s*/g) ?? [clean];
  const chunks: string[] = [];
  let current = "";
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length > max) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < s.length; i += max) chunks.push(s.slice(i, i + max));
      continue;
    }
    if ((current ? current.length + 1 : 0) + s.length > max) {
      chunks.push(current);
      current = s;
    } else {
      current = current ? `${current} ${s}` : s;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function useTTS(): TTSApi {
  const [supported, setSupported] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const tokenRef = useRef(0);
  const keepAlive = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    setSupported(true);
    const load = () => setVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.addEventListener("voiceschanged", load);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", load);
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* noop */
      }
      if (keepAlive.current) window.clearInterval(keepAlive.current);
    };
  }, []);

  const stopKeepAlive = useCallback(() => {
    if (keepAlive.current) {
      window.clearInterval(keepAlive.current);
      keepAlive.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    tokenRef.current += 1;
    stopKeepAlive();
    setSpeaking(false);
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* noop */
      }
    }
  }, [stopKeepAlive]);

  const speak = useCallback(
    (text: string, opts: SpeakOptions = {}) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        opts.onAllEnd?.();
        return;
      }
      const chunks = chunkForSpeech(text);
      if (!chunks.length) {
        opts.onAllEnd?.();
        return;
      }

      tokenRef.current += 1;
      const token = tokenRef.current;
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* noop */
      }

      const list = window.speechSynthesis.getVoices();
      const voice = opts.voiceURI ? list.find((v) => v.voiceURI === opts.voiceURI) : undefined;
      const rate = Math.min(2, Math.max(0.5, opts.rate ?? 1));

      setSpeaking(true);
      stopKeepAlive();
      keepAlive.current = window.setInterval(() => {
        try {
          if (window.speechSynthesis.speaking) window.speechSynthesis.resume();
        } catch {
          /* noop */
        }
      }, 6000);

      let index = 0;
      const finish = () => {
        if (token !== tokenRef.current) return;
        stopKeepAlive();
        setSpeaking(false);
        opts.onAllEnd?.();
      };

      const next = () => {
        if (token !== tokenRef.current) return;
        if (index >= chunks.length) {
          finish();
          return;
        }
        const u = new SpeechSynthesisUtterance(chunks[index]);
        index += 1;
        if (voice) u.voice = voice;
        u.rate = rate;
        u.onend = next;
        u.onerror = () => {
          if (token !== tokenRef.current) return;
          // Skip the failed chunk rather than stalling the conversation.
          next();
        };
        try {
          window.speechSynthesis.speak(u);
        } catch {
          finish();
        }
      };
      next();
    },
    [stopKeepAlive],
  );

  return { supported, speaking, voices, speak, cancel };
}
