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
    /** the conversation each model call was shown, serialised */
    sent: [] as string[],
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
        llm.sent.push(JSON.stringify(args.turns));
        const step = llm.steps.shift();
        if (!step) throw new Error("unscripted model call");
        return step(args);
      },
      complete: async () => "",
      models: async () => [],
    }),
  };
});

const { EMPTY_REPLY, STOPPED_NOTE, activityNote, historyTurns, runChatTurn, stopChatTurn } = await import(
  "@/lib/ai/chat"
);
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
  llm.sent = [];
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
    const events = await turn("hello?");
    const first = last(events);
    expect(first).toMatchObject({ type: "error", message: NOT_CONFIGURED });
    const id = first.type === "error" ? first.conversationId : undefined;
    expect(id).toBeTruthy();
    // The client knew it before the failure, from the opening event.
    expect(events[0]).toMatchObject({ type: "meta", conversationId: id });

    const second = last(await turn("hello again", id!));
    expect(second).toMatchObject({ type: "error", conversationId: id });
    expect(conversationsRepo.messages(id!).filter((m) => m.role === "user")).toHaveLength(2);
  });
});

describe("runChatTurn — stop", () => {
  const decode = (chunk: Uint8Array): ChatStreamEvent[] =>
    new TextDecoder()
      .decode(chunk)
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => JSON.parse(f.slice(6)) as ChatStreamEvent);

  /** Read until `until` has been seen, keeping every event. */
  async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, until: (e: ChatStreamEvent) => boolean) {
    const seen: ChatStreamEvent[] = [];
    while (!seen.some(until)) {
      const { value, done } = await reader.read();
      if (done) break;
      seen.push(...decode(value!));
    }
    return seen;
  }

  const saved = (title: string) => {
    const conversation = conversationsRepo.listRecent(50).find((c) => c.title === title);
    const reply = conversation
      ? conversationsRepo.messages(conversation.id).find((m) => m.role === "assistant")
      : undefined;
    return { conversation, reply };
  };

  /** Round 0 adds one errand; round 1 (slow, abortable) adds another; round 2 says so. */
  function errands(first = "Buy oat milk", second = "Buy stamps") {
    llm.steps = [
      () => ({ text: "", toolCalls: [call("create_task", { title: first }, "c1")] }),
      (args) =>
        new Promise<StreamOutcome>((resolve, reject) => {
          const timer = setTimeout(
            () => resolve({ text: "", toolCalls: [call("create_task", { title: second }, "c2")] }),
            40,
          );
          args.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
      says("Added both errands."),
    ];
  }

  it("opens every turn with its id and conversation", async () => {
    llm.steps = [says("Hi")];
    const events = await turn("meta check");
    expect(events[0]).toMatchObject({ type: "meta" });
    const meta = events[0].type === "meta" ? events[0] : null;
    expect(meta?.turnId).toBeTruthy();
    expect(last(events)).toMatchObject({ type: "done", conversationId: meta?.conversationId });
    // Finished turns can't be stopped any more.
    expect(stopChatTurn(meta!.turnId)).toBe(false);
  });

  it("lets a turn finish its plan when the reader simply goes away", async () => {
    errands();
    const reader = runChatTurn({ conversationId: null, message: "errands, then gone", mode: "chat" }).getReader();
    await readUntil(reader, (e) => e.type === "tool" && e.status === "ok");
    await reader.cancel(); // another chat, another page, a phone in a pocket

    await vi.waitFor(() => expect(saved("errands, then gone").reply).toBeTruthy());
    expect(saved("errands, then gone").reply?.text).toBe("Added both errands.");
    expect(tasksRepo.list({}).map((t) => t.title)).toEqual(expect.arrayContaining(["Buy oat milk", "Buy stamps"]));
  });

  it("stops at an explicit Stop: the model call in flight is cut, no failover, nothing new runs", async () => {
    llm.backup = { kind: "anthropic", baseUrl: "", apiKey: "k", model: "backup-model" };
    errands("Post the parcel", "Buy envelopes");
    const reader = runChatTurn({ conversationId: null, message: "errands, then stop", mode: "chat" }).getReader();
    const seen = await readUntil(reader, (e) => e.type === "tool" && e.status === "ok");
    const meta = seen.find((e) => e.type === "meta");
    expect(meta?.type === "meta" && stopChatTurn(meta.turnId)).toBe(true);
    await reader.cancel();

    await vi.waitFor(() => expect(saved("errands, then stop").reply).toBeTruthy());
    const { reply } = saved("errands, then stop");
    expect(reply?.text).toBe(STOPPED_NOTE);
    expect(reply?.activity.map((a) => a.label).join()).toContain("Post the parcel");
    expect(llm.calls).toEqual(["openai", "openai"]);
    expect(llm.records).toEqual([]);
    expect(tasksRepo.list({}).map((t) => t.title)).not.toContain("Buy envelopes");
  });

  it("lets the tool already running finish, then stops before the next one", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    llm.steps = [
      async (args) => {
        args.onText("On it");
        await gate;
        return {
          text: "On it",
          toolCalls: [call("create_task", { title: "Never added" }, "n1"), call("create_task", { title: "Nor this" }, "n2")],
        };
      },
      says("this round should never be asked for"),
    ];
    const reader = runChatTurn({ conversationId: null, message: "stop before tools", mode: "chat" }).getReader();
    const seen = await readUntil(reader, (e) => e.type === "token");
    const meta = seen.find((e) => e.type === "meta");
    if (meta?.type === "meta") stopChatTurn(meta.turnId);
    release();

    await vi.waitFor(() => expect(saved("stop before tools").reply).toBeTruthy());
    expect(saved("stop before tools").reply?.text).toBe("On it");
    expect(llm.calls).toHaveLength(1);
    const titles = tasksRepo.list({}).map((t) => t.title);
    expect(titles).not.toContain("Never added");
    expect(titles).not.toContain("Nor this");
  });

  it("shows the next turn what a stopped turn already did, so 'carry on' doesn't redo it", async () => {
    errands("Buy birthday card", "Wrap the present");
    const reader = runChatTurn({ conversationId: null, message: "card, then stop", mode: "chat" }).getReader();
    const seen = await readUntil(reader, (e) => e.type === "tool" && e.status === "ok");
    const meta = seen.find((e) => e.type === "meta");
    if (meta?.type === "meta") stopChatTurn(meta.turnId);
    await reader.cancel();
    await vi.waitFor(() => expect(saved("card, then stop").reply).toBeTruthy());

    llm.steps = [says("Carrying on.")];
    await turn("carry on", saved("card, then stop").conversation!.id);
    expect(llm.sent[llm.sent.length - 1]).toContain("Buy birthday card");
  });
});

describe("historyTurns", () => {
  const record = (role: "user" | "assistant", text: string, activity: { label: string; ok: boolean }[] = []) => ({
    id: Math.random().toString(36),
    conversationId: "c",
    role,
    text,
    activity,
    createdAt: "2026-10-27T12:00:00.000Z",
  });

  it("adds a short note of the tool work to each assistant turn", () => {
    const turns = historyTurns([
      record("user", "add oat milk and tick off the gym"),
      record("assistant", "Stopped.", [
        { label: "Added “Buy oat milk”", ok: true },
        { label: "Task gym-1 not found", ok: false },
      ]),
      record("user", "carry on"),
    ]);
    expect(turns[1]).toMatchObject({
      role: "assistant",
      text: "Stopped.\n(Done: Added “Buy oat milk”. Didn't work: Task gym-1 not found)",
    });
  });

  it("keeps a turn whose only trace is its tool work, and skips labels the text already says", () => {
    const turns = historyTurns([
      record("user", "add it"),
      record("assistant", "", [{ label: "Added “Call mum”", ok: true }]),
      record("user", "and again"),
      record("assistant", "Added “Call mum”.", [{ label: "Added “Call mum”", ok: true }]),
    ]);
    expect(turns[1]).toMatchObject({ role: "assistant", text: "(Done: Added “Call mum”)" });
    expect(turns[3]).toMatchObject({ role: "assistant", text: "Added “Call mum”." });
  });

  it("stays compact however much a turn did", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ label: `Added “Task ${i}”`, ok: true }));
    const note = activityNote("", many);
    expect(note.match(/Added/g)).toHaveLength(8);
  });
});
