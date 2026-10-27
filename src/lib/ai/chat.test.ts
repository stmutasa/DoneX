import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatStreamEvent } from "@/lib/types";
import type { LlmToolCall, ProviderConfig, StreamArgs, StreamOutcome } from "@/lib/ai/provider";

// A throwaway data directory per run, so the real one is never touched.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "donex-chat-"));
process.env.DATA_DIR = DIR;

// The providers, scripted: each stream call takes the next step.
const llm = vi.hoisted(() => {
  const primary = { kind: "openai", baseUrl: "", apiKey: "k", model: "primary-model" } as const;
  return {
    primary,
    configured: true,
    standIn: null as string | null,
    backup: null as { kind: "anthropic"; baseUrl: string; apiKey: string; model: string } | null,
    steps: [] as Array<(args: StreamArgs) => StreamOutcome | Promise<StreamOutcome>>,
    calls: [] as string[],
    records: [] as { from: string; to: string; reason: string }[],
  };
});

vi.mock("@/lib/ai/adapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/adapters")>();
  return {
    ...actual,
    aiConfigured: () => llm.configured,
    workingConfig: async () => ({
      cfg: (llm.standIn ? llm.backup! : llm.primary) as ProviderConfig,
      standIn: llm.standIn,
    }),
    fallbackConfig: async () => llm.backup as ProviderConfig | null,
    recordFallback: (from: string, to: ProviderConfig, reason: string) => {
      llm.records.push({ from, to: to.kind, reason });
    },
    adapterFor: () => ({
      stream: async (args: StreamArgs) => {
        llm.calls.push(args.cfg.kind);
        const step = llm.steps.shift();
        if (!step) throw new Error("unscripted model call");
        return step(args);
      },
      complete: async () => "",
      models: async () => [],
    }),
  };
});

const { EMPTY_REPLY, STOPPED_NOTE, runChatTurn } = await import("@/lib/ai/chat");
const { conversationsRepo, settingsRepo, tasksRepo } = await import("@/lib/db/repos");
const { NOT_CONFIGURED } = await import("@/lib/ai/provider");

beforeAll(() => {
  settingsRepo.updateApp({ tz: "America/New_York" });
});

afterAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

beforeEach(() => {
  llm.configured = true;
  llm.standIn = null;
  llm.backup = null;
  llm.steps = [];
  llm.calls = [];
  llm.records = [];
});

async function turn(message: string, conversationId: string | null = null): Promise<ChatStreamEvent[]> {
  const body = await new Response(runChatTurn({ conversationId, message, mode: "chat" })).text();
  return body
    .split("\n\n")
    .filter((frame) => frame.startsWith("data: "))
    .map((frame) => JSON.parse(frame.slice(6)) as ChatStreamEvent);
}

const text = (events: ChatStreamEvent[]) =>
  events.map((e) => (e.type === "token" ? e.text : "")).join("");
const last = (events: ChatStreamEvent[]) => events[events.length - 1];
const call = (name: string, args: Record<string, unknown>, id = name): LlmToolCall => ({
  id,
  name,
  args: JSON.stringify(args),
});
const says = (reply: string) => (args: StreamArgs): StreamOutcome => {
  args.onText(reply);
  return { text: reply, toolCalls: [] };
};
const silent = (): StreamOutcome => ({ text: "", toolCalls: [] });

describe("runChatTurn — replies", () => {
  it("treats an empty reply as an error, never as 'Done.'", async () => {
    llm.steps = [silent];
    const events = await turn("move my 3pm to tomorrow");

    expect(text(events)).toBe("");
    const end = last(events);
    expect(end).toMatchObject({ type: "error", message: EMPTY_REPLY });
    const conversationId = end.type === "error" ? end.conversationId : undefined;
    expect(conversationId).toBeTruthy();
    const saved = conversationsRepo.messages(conversationId!);
    expect(saved.map((m) => m.text)).not.toContain("Done.");
    expect(saved.find((m) => m.role === "assistant")?.text).toBe(`Sorry — ${EMPTY_REPLY}`);
  });

  it("reports what the tools did when the model then goes quiet", async () => {
    llm.steps = [() => ({ text: "", toolCalls: [call("create_task", { title: "Buy oat milk" })] }), silent];
    const events = await turn("add oat milk");

    expect(last(events)).toMatchObject({ type: "done" });
    expect(text(events)).toContain("Buy oat milk");
  });

  it("says when every tool failed instead of claiming success", async () => {
    llm.steps = [() => ({ text: "", toolCalls: [call("complete_task", { id: "no-such-task" })] }), silent];
    const events = await turn("tick off the thing");

    expect(text(events)).toMatch(/^That didn't work: .*not found/);
  });

  it("names the steps it dropped when the rounds run out", async () => {
    llm.steps = Array.from({ length: 7 }, (_, round) => () => ({
      text: "",
      toolCalls: [call("create_task", { title: `Errand ${round}` }, `c${round}`)],
    }));
    const events = await turn("add seven errands");

    const reply = text(events);
    expect(reply).toContain("step limit");
    expect(reply).toContain("Errand 6");
    const titles = tasksRepo.list({}).map((t) => t.title);
    expect(titles).toContain("Errand 5");
    expect(titles).not.toContain("Errand 6");
  });
});

describe("runChatTurn — failover", () => {
  const backup = { kind: "anthropic" as const, baseUrl: "", apiKey: "k", model: "backup-model" };

  it("hands over once and records it only after the backup answers", async () => {
    llm.backup = backup;
    llm.steps = [
      () => {
        throw new Error("HTTP 503");
      },
      says("Hello from the backup"),
    ];
    const events = await turn("hi");

    expect(llm.calls).toEqual(["openai", "anthropic"]);
    expect(last(events)).toMatchObject({ type: "done", text: "Hello from the backup" });
    expect(llm.records).toEqual([{ from: "openai", to: "anthropic", reason: "HTTP 503" }]);
  });

  it("doesn't retry a stand-in that fails, or report it as covering", async () => {
    llm.backup = backup;
    llm.standIn = "OpenAI has no API key set";
    llm.steps = [
      () => {
        throw new Error("Anthropic rejected the API key");
      },
    ];
    const events = await turn("hi");

    expect(llm.calls).toEqual(["anthropic"]);
    expect(llm.records).toEqual([]);
    // The owner hears why the backup was covering, not just that it failed.
    expect(last(events)).toMatchObject({
      type: "error",
      message:
        "OpenAI has no API key set — and the anthropic backup (backup-model) also failed: Anthropic rejected the API key",
    });
  });

  it("doesn't go back to the backup a second time when it fails in a later round", async () => {
    llm.backup = backup;
    llm.steps = [
      () => {
        throw new Error("HTTP 503");
      },
      () => ({ text: "", toolCalls: [call("create_task", { title: "Renew passport" })] }),
      () => {
        throw new Error("HTTP 529");
      },
    ];
    const events = await turn("add renew passport");

    expect(llm.calls).toEqual(["openai", "anthropic", "anthropic"]);
    expect(llm.records).toHaveLength(1);
    expect(last(events)).toMatchObject({
      type: "error",
      message: "HTTP 503 — and the anthropic backup (backup-model) also failed: HTTP 529",
    });
  });

  it("records a stand-in that answers, once per turn", async () => {
    llm.backup = backup;
    llm.standIn = "OpenAI has no API key set";
    llm.steps = [() => ({ text: "", toolCalls: [call("create_task", { title: "Water the plants" })] }), says("Added.")];
    await turn("add water the plants");

    expect(llm.records).toHaveLength(1);
    expect(llm.records[0]).toMatchObject({ to: "anthropic", reason: "OpenAI has no API key set" });
  });
});

describe("runChatTurn — errors", () => {
  it("names the conversation a failed turn was saved in, so a retry joins it", async () => {
    llm.configured = false;
    const first = last(await turn("hello?"));
    expect(first).toMatchObject({ type: "error", message: NOT_CONFIGURED });
    const id = first.type === "error" ? first.conversationId : undefined;
    expect(id).toBeTruthy();

    const second = last(await turn("hello again", id!));
    expect(second).toMatchObject({ type: "error", conversationId: id });
    expect(conversationsRepo.messages(id!).filter((m) => m.role === "user")).toHaveLength(2);
  });
});

describe("runChatTurn — stop", () => {
  const savedReply = (title: string) => {
    const conversation = conversationsRepo.listRecent(20).find((c) => c.title === title);
    return conversation ? conversationsRepo.messages(conversation.id).find((m) => m.role === "assistant") : undefined;
  };

  it("stops before the next tool and the next paid round once the reader goes away", async () => {
    let release: () => void = () => {};
    llm.steps = [
      async (args) => {
        args.onText("On it");
        await new Promise<void>((r) => (release = r));
        return { text: "On it", toolCalls: [call("create_task", { title: "Never added" })] };
      },
      says("this round should never be asked for"),
    ];
    const reader = runChatTurn({ conversationId: null, message: "stop test one", mode: "chat" }).getReader();
    await reader.read(); // the first token
    await reader.cancel();
    release();

    await vi.waitFor(() => expect(savedReply("stop test one")).toBeTruthy());
    expect(savedReply("stop test one")?.text).toBe("On it");
    expect(llm.calls).toHaveLength(1);
    expect(tasksRepo.list({}).map((t) => t.title)).not.toContain("Never added");
  });

  it("aborts the model call in flight without failing over, and saves a short note", async () => {
    llm.backup = { kind: "anthropic", baseUrl: "", apiKey: "k", model: "backup-model" };
    let started: () => void = () => {};
    const streaming = new Promise<void>((r) => (started = r));
    llm.steps = [
      (args) =>
        new Promise<StreamOutcome>((_, reject) => {
          started();
          args.signal.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    ];
    const reader = runChatTurn({ conversationId: null, message: "stop test two", mode: "chat" }).getReader();
    void reader.read();
    await streaming;
    await reader.cancel();

    await vi.waitFor(() => expect(savedReply("stop test two")).toBeTruthy());
    expect(savedReply("stop test two")?.text).toBe(STOPPED_NOTE);
    expect(llm.calls).toEqual(["openai"]);
    expect(llm.records).toEqual([]);
  });
});
