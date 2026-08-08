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

  // Mic level meter — only while actually listening.
  useEffect(() => {
    if (phase !== "listening") {
      setMicLevel(0);
      return;
    }
    let cancelled = false;
    let raf = 0;
    let stream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;

    const run = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        const Ctor =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        audioCtx = new Ctor();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.75;
        source.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i += 1) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          setMicLevel((prev) => prev * 0.65 + Math.min(1, rms * 4.5) * 0.35);
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        // Permission denied / no device — orb simply won't react.
      }
    };
    void run();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      audioCtx?.close().catch(() => undefined);
      setMicLevel(0);
    };
  }, [phase]);

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
