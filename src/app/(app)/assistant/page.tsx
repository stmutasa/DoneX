"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import useSWR, { useSWRConfig } from "swr";
import { AnimatePresence } from "framer-motion";
import { chatApi, fetcher, keys, matchKey, postChatStream } from "@/lib/api";
import type { ChatMessageRecord, ChatRole, Conversation } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAutoGrow } from "@/hooks/useAutoGrow";
import { IconButton } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { IconList, IconMic, IconPlus, IconSend, IconStop } from "@/components/ui/icons";
import {
  ChatBubble,
  toolChipsFromActivity,
  type ToolChipState,
} from "@/components/chat/ChatMessage";
import { ConversationDrawer } from "@/components/chat/ConversationDrawer";

const STORAGE_KEY = "donex-conversation";

interface UiMessage {
  id: string;
  role: ChatRole;
  text: string;
  tools: ToolChipState[];
  pending?: boolean;
  error?: string;
}

const SUGGESTIONS = [
  "Plan my day",
  "What should I do next?",
  "Add: call the dentist tomorrow at 10",
  "How was my week?",
];

function toUi(record: ChatMessageRecord): UiMessage {
  return {
    id: record.id,
    role: record.role,
    text: record.text,
    tools: toolChipsFromActivity(record.activity ?? []),
  };
}

function mergeTool(
  tools: ToolChipState[],
  label: string,
  status: ToolChipState["status"],
): ToolChipState[] {
  if (status === "start") return [...tools, { label, status }];
  const idx = tools.findIndex((t) => t.label === label && t.status === "start");
  if (idx >= 0) {
    const next = tools.slice();
    next[idx] = { label, status };
    return next;
  }
  return [...tools, { label, status }];
}

export default function AssistantPage() {
  const router = useRouter();
  const toast = useToast();
  const { mutate: globalMutate } = useSWRConfig();

  const [ready, setReady] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const streamingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useAutoGrow(textareaRef, input, 140);

  useEffect(() => {
    try {
      setConversationId(localStorage.getItem(STORAGE_KEY));
    } catch {
      /* ignore */
    }
    setReady(true);
  }, []);

  const persist = useCallback((id: string) => {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  }, []);

  const { data: history, isLoading } = useSWR<{
    conversation: Conversation | null;
    messages: ChatMessageRecord[];
  }>(ready ? keys.history(conversationId) : null, fetcher, { revalidateOnFocus: false });

  useEffect(() => {
    if (!history || streamingRef.current) return;
    setMessages(history.messages.map(toUi));
    if (history.conversation && history.conversation.id !== conversationId) {
      setConversationId(history.conversation.id);
      persist(history.conversation.id);
    }
  }, [history, conversationId, persist]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !atBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  };

  const send = async (raw: string) => {
    const text = raw.trim();
    if (!text || streamingRef.current) return;
    setInput("");
    atBottom.current = true;

    const stamp = Date.now();
    const userId = `u-${stamp}`;
    const asstId = `a-${stamp}`;
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", text, tools: [] },
      { id: asstId, role: "assistant", text: "", tools: [], pending: true },
    ]);

    streamingRef.current = true;
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let acc = "";

    await postChatStream(
      { conversationId, message: text, mode: "chat" },
      {
        onToken: (chunk) => {
          acc += chunk;
          setMessages((prev) =>
            prev.map((m) => (m.id === asstId ? { ...m, text: acc, pending: false } : m)),
          );
        },
        onTool: (label, status) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === asstId ? { ...m, tools: mergeTool(m.tools, label, status) } : m)),
          );
        },
        onDone: (payload) => {
          if (payload.conversationId) {
            setConversationId(payload.conversationId);
            persist(payload.conversationId);
          }
          setMessages((prev) =>
            prev.map((m) =>
              m.id === asstId
                ? {
                    ...m,
                    text: payload.text || acc,
                    pending: false,
                    tools: toolChipsFromActivity(payload.activity ?? []),
                  }
                : m,
            ),
          );
        },
        onError: (message) => {
          toast.error(message);
          setMessages((prev) =>
            prev.map((m) => (m.id === asstId ? { ...m, pending: false, error: message } : m)),
          );
        },
      },
      controller.signal,
    );

    streamingRef.current = false;
    setStreaming(false);
    abortRef.current = null;
    void globalMutate(
      matchKey("/api/tasks", "/api/stats", "/api/notes", "/api/inbox", "/api/projects", "/api/chat/conversations"),
    );
  };

  const startNew = async () => {
    try {
      const { conversation } = await chatApi.newConversation();
      setConversationId(conversation.id);
      persist(conversation.id);
      setMessages([]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start a chat");
    }
  };

  const showSuggestions = !isLoading && messages.length === 0;

  return (
    <div className="flex h-[100dvh] flex-col">
      <header className="flex shrink-0 items-center gap-1 border-b border-stroke bg-bg/85 px-3 pb-2.5 pt-[calc(0.625rem+env(safe-area-inset-top,0px))] backdrop-blur-xl">
        <IconButton label="Conversations" onClick={() => setDrawerOpen(true)}>
          <IconList className="h-5 w-5" />
        </IconButton>
        <h1 className="flex-1 truncate text-[16px] font-semibold tracking-tight text-ink">
          {history?.conversation?.title || "Assistant"}
        </h1>
        <IconButton label="New conversation" onClick={startNew}>
          <IconPlus className="h-5 w-5" />
        </IconButton>
      </header>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-4"
      >
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
          {isLoading ? (
            <>
              <div className="skeleton h-12 w-2/3 self-start rounded-2xl" />
              <div className="skeleton h-16 w-3/4 self-end rounded-2xl" />
            </>
          ) : null}

          {showSuggestions ? (
            <div className="animate-fade-in pt-8 text-center">
              <div className="mb-3 text-4xl">🌤️</div>
              <h2 className="text-xl font-semibold tracking-tight text-ink">How can I help?</h2>
              <p className="mt-1 text-[14px] text-muted">Ask, plan, or just think out loud.</p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => void send(s)}
                    className="rounded-full border border-stroke bg-elev px-3.5 py-2 text-[13.5px] text-muted transition-colors hover:border-accent hover:text-ink"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <AnimatePresence initial={false}>
            {messages.map((m) => (
              <ChatBubble
                key={m.id}
                role={m.role}
                text={m.text}
                tools={m.tools}
                pending={m.pending}
                error={m.error}
              />
            ))}
          </AnimatePresence>
        </div>
      </div>

      <div className="shrink-0 border-t border-stroke bg-bg/90 px-3 pt-2.5 backdrop-blur-xl pb-[calc(env(safe-area-inset-bottom,0px)+64px)] lg:pb-4">
        <div className="mx-auto flex w-full max-w-2xl items-end gap-2">
          <IconButton label="Walk mode" onClick={() => router.push("/voice")}>
            <IconMic className="h-5 w-5" />
          </IconButton>
          <textarea
            ref={textareaRef}
            value={input}
            rows={1}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder="Message DoneX…"
            enterKeyHint="send"
            className="max-h-[140px] min-h-[44px] flex-1 resize-none rounded-2xl border border-stroke bg-sunken px-3.5 py-3 text-[15px] leading-snug text-ink outline-none placeholder:text-faint focus:border-stroke-strong"
          />
          <button
            type="button"
            aria-label={streaming ? "Stop generating" : "Send message"}
            onClick={() => (streaming ? abortRef.current?.abort() : void send(input))}
            disabled={!streaming && !input.trim()}
            className={cn(
              "grid h-11 w-11 shrink-0 place-items-center rounded-full transition-all active:scale-95",
              streaming
                ? "border border-stroke bg-elev text-ink"
                : "bg-sunrise text-on-accent disabled:opacity-40",
            )}
          >
            {streaming ? <IconStop className="h-4 w-4" /> : <IconSend className="h-[18px] w-[18px]" />}
          </button>
        </div>
      </div>

      <ConversationDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        activeId={conversationId}
        onSelect={(id) => {
          setConversationId(id);
          persist(id);
          setMessages([]);
        }}
        onNew={(c) => {
          setConversationId(c.id);
          persist(c.id);
          setMessages([]);
        }}
      />
    </div>
  );
}
