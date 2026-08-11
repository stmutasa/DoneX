"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { postChatStream } from "@/lib/api";
import { useSpeechRecognition, type SpeechError } from "./useSpeechRecognition";
import { useTTS } from "./useTTS";

export type VoicePhase = "idle" | "listening" | "thinking" | "speaking";

export interface VoiceTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface VoiceConversationOptions {
  conversationId: string | null;
  autoListen: boolean;
  voiceURI?: string;
  rate?: number;
  onConversationId?: (id: string) => void;
  onError?: (message: string) => void;
}

export interface VoiceConversationApi {
  phase: VoicePhase;
  interim: string;
  lastReply: string;
  turns: VoiceTurn[];
  micLevel: number;
  supported: boolean;
  micError: SpeechError;
  ttsSupported: boolean;
  start: () => void;
  stop: () => void;
  interrupt: () => void;
  sendText: (text: string) => void;
}

let turnSeq = 0;
const nextTurnId = () => `t${++turnSeq}`;

export function useVoiceConversation(
  options: VoiceConversationOptions,
): VoiceConversationApi {
  const rec = useSpeechRecognition();
  const tts = useTTS();

  const [phase, setPhaseState] = useState<VoicePhase>("idle");
  const [lastReply, setLastReply] = useState("");
  const [turns, setTurns] = useState<VoiceTurn[]>([]);
  const [micLevel, setMicLevel] = useState(0);

  const phaseRef = useRef<VoicePhase>("idle");
  const sessionRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const silentCyclesRef = useRef(0);
  const restartTimerRef = useRef<number | null>(null);
  const optsRef = useRef(options);
  optsRef.current = options;

  const setPhase = useCallback((next: VoicePhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const beginListening = useCallback(() => {
    if (!sessionRef.current) return;
    setPhase("listening");
    rec.start();
  }, [rec, setPhase]);

  const runTurn = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message) {
        if (sessionRef.current) beginListening();
        return;
      }
      rec.stop();
      setPhase("thinking");
      setLastReply("");
      setTurns((prev) => [...prev, { id: nextTurnId(), role: "user", text: message }]);

      const controller = new AbortController();
      abortRef.current = controller;

      let streamed = "";
      let finalText = "";
      let failure: string | null = null;

      await postChatStream(
        {
          conversationId: optsRef.current.conversationId,
          message,
          mode: "voice",
        },
        {
          onToken: (chunk) => {
            streamed += chunk;
            setLastReply(streamed);
          },
          onDone: (payload) => {
            finalText = payload.text || streamed;
            optsRef.current.onConversationId?.(payload.conversationId);
          },
          onError: (msg) => {
            failure = msg;
          },
        },
        controller.signal,
      );

      if (abortRef.current === controller) abortRef.current = null;
      if (controller.signal.aborted) return;

      if (failure) {
        optsRef.current.onError?.(failure);
        setPhase("idle");
        return;
      }

      const reply = (finalText || streamed).trim();
      if (!reply) {
        setPhase("idle");
        return;
      }
      setLastReply(reply);
      setTurns((prev) => [...prev, { id: nextTurnId(), role: "assistant", text: reply }]);
      setPhase("speaking");
      tts.speak(reply, {
        voiceURI: optsRef.current.voiceURI,
        rate: optsRef.current.rate,
        onAllEnd: () => {
          if (!sessionRef.current) {
            setPhase("idle");
            return;
          }
          if (optsRef.current.autoListen) beginListening();
          else setPhase("idle");
        },
      });
    },
    [beginListening, rec, setPhase, tts],
  );

  const runTurnRef = useRef(runTurn);
  runTurnRef.current = runTurn;

  useEffect(() => {
    rec.onFinal((text) => {
      silentCyclesRef.current = 0;
      void runTurnRef.current(text);
    });
  }, [rec]);

  // Recognition ended without a result. While a hands-free session is live,
  // quietly restart listening so pauses on a walk don't end the conversation;
  // give up after ~8 empty cycles (≈ a minute of silence) or on a mic error.
  useEffect(() => {
    if (rec.listening || phaseRef.current !== "listening") return;
    if (!sessionRef.current || rec.error) {
      setPhase("idle");
      return;
    }
    silentCyclesRef.current += 1;
    if (silentCyclesRef.current > 8) {
      sessionRef.current = false;
      setPhase("idle");
      return;
    }
    restartTimerRef.current = window.setTimeout(() => {
      if (sessionRef.current && phaseRef.current === "listening") rec.start();
    }, 250);
    return () => {
      if (restartTimerRef.current) window.clearTimeout(restartTimerRef.current);
    };
  }, [rec, rec.listening, rec.error, setPhase]);

  // Orb "level" while listening — a synthetic breathing pulse that kicks up
  // whenever speech recognition actually reports new interim text. This is
  // deliberately NOT backed by a second getUserMedia() stream: opening a raw
  // mic capture alongside the SpeechRecognition session starves it of audio
  // on many Android devices (only one exclusive mic consumer at a time),
  // which is why recognition would hear nothing and time out immediately.
  const kickRef = useRef(0);
  useEffect(() => {
    if (phase !== "listening") {
      setMicLevel(0);
      return;
    }
    kickRef.current = 1;
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const elapsed = t - start;
      kickRef.current = Math.max(0, kickRef.current - 0.035);
      const breathe = 0.3 + 0.12 * Math.sin(elapsed / 420);
      setMicLevel(Math.min(1, breathe + kickRef.current));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      setMicLevel(0);
    };
  }, [phase]);

  useEffect(() => {
    if (rec.interim) kickRef.current = 1;
  }, [rec.interim]);

  const start = useCallback(() => {
    sessionRef.current = true;
    silentCyclesRef.current = 0;
    tts.cancel();
    beginListening();
  }, [beginListening, tts]);

  const stop = useCallback(() => {
    sessionRef.current = false;
    if (restartTimerRef.current) window.clearTimeout(restartTimerRef.current);
    abortRef.current?.abort();
    abortRef.current = null;
    tts.cancel();
    rec.stop();
    setPhase("idle");
  }, [rec, setPhase, tts]);

  const interrupt = useCallback(() => {
    sessionRef.current = true;
    silentCyclesRef.current = 0;
    tts.cancel();
    abortRef.current?.abort();
    abortRef.current = null;
    beginListening();
  }, [beginListening, tts]);

  const sendText = useCallback((text: string) => {
    sessionRef.current = true;
    void runTurnRef.current(text);
  }, []);

  useEffect(
    () => () => {
      sessionRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    },
    [],
  );

  return {
    phase,
    interim: rec.interim,
    lastReply,
    turns,
    micLevel,
    supported: rec.supported,
    micError: rec.error,
    ttsSupported: tts.supported,
    start,
    stop,
    interrupt,
    sendText,
  };
}
