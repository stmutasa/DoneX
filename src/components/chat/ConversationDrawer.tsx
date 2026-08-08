"use client";

import useSWR from "swr";
import { chatApi, fetcher, keys } from "@/lib/api";
import type { Conversation } from "@/lib/types";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/Misc";
import { useToast } from "@/components/ui/Toast";
import { IconPlus } from "@/components/ui/icons";

export function ConversationDrawer({
  open,
  onClose,
  activeId,
  onSelect,
  onNew,
}: {
  open: boolean;
  onClose: () => void;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: (conversation: Conversation) => void;
}) {
  const toast = useToast();
  const { data, mutate, isLoading } = useSWR<{ conversations: Conversation[] }>(
    open ? keys.conversations() : null,
    fetcher,
  );
  const conversations = data?.conversations ?? [];

  const startNew = async () => {
    try {
      const { conversation } = await chatApi.newConversation();
      await mutate();
      onNew(conversation);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start a chat");
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Conversations"
      footer={
        <Button block variant="primary" icon={<IconPlus className="h-4 w-4" />} onClick={startNew}>
          New conversation
        </Button>
      }
    >
      {isLoading ? (
        <div className="space-y-2 py-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-14 rounded-2xl" />
          ))}
        </div>
      ) : conversations.length === 0 ? (
        <EmptyState emoji="💬" title="No conversations yet" message="Start one and it’ll live here." />
      ) : (
        <ul className="space-y-1 pb-2">
          {conversations.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => {
                  onSelect(c.id);
                  onClose();
                }}
                className={cn(
                  "flex w-full min-h-[52px] flex-col justify-center rounded-2xl px-3 py-2 text-left transition-colors",
                  c.id === activeId ? "bg-accent-soft" : "hover:bg-sunken",
                )}
              >
                <span
                  className={cn(
                    "truncate text-[15px]",
                    c.id === activeId ? "font-medium text-accent" : "text-ink",
                  )}
                >
                  {c.title || "Untitled"}
                </span>
                <span className="text-[12px] text-faint">{relativeTime(c.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
