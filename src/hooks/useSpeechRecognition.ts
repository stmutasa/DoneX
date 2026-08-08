"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface RecAlternative {
  transcript: string;
}
interface RecResult {
  isFinal: boolean;
  0: RecAlternative;
  length: number;
}
interface RecResultList {
  length: number;
  [index: number]: RecResult;
}
interface RecEvent {
  resultIndex: number;
  results: RecResultList;
}
interface RecErrorEvent {
  error: string;
  message?: string;
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: RecEvent) => void) | null;
  onerror: ((e: RecErrorEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}
type RecognitionCtor = new () => RecognitionLike;

function getCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export type SpeechError = "denied" | "no-mic" | "network" | "unknown" | null;

export interface SpeechRecognitionApi {
  supported: boolean;
  listening: boolean;
  interim: string;
  error: SpeechError;
  start: () => void;
  stop: () => void;
  onFinal: (cb: (text: string) => void) => void;
  clearError: () => void;
}

/**
 * Single-utterance recognition with interim results. Restart-safe:
 * double `start()` is swallowed, `no-speech` is treated as benign.
 */
export function useSpeechRecognition(): SpeechRecognitionApi {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<SpeechError>(null);

  const recRef = useRef<RecognitionLike | null>(null);
  const activeRef = useRef(false);
  const finalCb = useRef<((text: string) => void) | null>(null);

  useEffect(() => {
    const Ctor = getCtor();
    if (!Ctor) {
      setSupported(false);
      return;
    }
    setSupported(true);
    const rec = new Ctor();
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = navigator.language || "en-US";

    rec.onstart = () => {
      activeRef.current = true;
      setListening(true);
      setInterim("");
    };
    rec.onresult = (e) => {
      let interimText = "";
      let finalText = "";
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const res = e.results[i];
        const text = res[0]?.transcript ?? "";
        if (res.isFinal) finalText += text;
        else interimText += text;
      }
      if (interimText) setInterim(interimText);
      if (finalText.trim()) {
        setInterim("");
        finalCb.current?.(finalText.trim());
      }
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") setError("denied");
      else if (e.error === "audio-capture") setError("no-mic");
      else if (e.error === "network") setError("network");
      else setError("unknown");
    };
    rec.onend = () => {
      activeRef.current = false;
      setListening(false);
      setInterim("");
    };

    recRef.current = rec;
    return () => {
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      rec.onstart = null;
      try {
        rec.abort();
      } catch {
        /* already stopped */
      }
      recRef.current = null;
      activeRef.current = false;
    };
  }, []);

  const start = useCallback(() => {
    const rec = recRef.current;
    if (!rec || activeRef.current) return;
    try {
      rec.start();
      activeRef.current = true;
    } catch {
      // InvalidStateError — recognition already running; ignore.
    }
  }, []);

  const stop = useCallback(() => {
    const rec = recRef.current;
    if (!rec) return;
    try {
      rec.abort();
    } catch {
      /* noop */
    }
    activeRef.current = false;
    setListening(false);
    setInterim("");
  }, []);

  const onFinal = useCallback((cb: (text: string) => void) => {
    finalCb.current = cb;
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { supported, listening, interim, error, start, stop, onFinal, clearError };
}
