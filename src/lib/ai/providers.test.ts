import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AISettings } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  app: { tz: "America/New_York", ai: {} as AISettings },
  kv: new Map<string, string>(),
  usage: [] as Array<Record<string, unknown>>,
  pushes: [] as unknown[],
}));

vi.mock("@/lib/db/repos", () => ({
  settingsRepo: {
    getApp: () => mocks.app,
    updateApp: (patch: { ai?: Partial<AISettings> }) => {
      mocks.app = { ...mocks.app, ai: { ...mocks.app.ai, ...(patch.ai ?? {}) } };
    },
    getKV: (key: string) => mocks.kv.get(key) ?? null,
    setKV: (key: string, value: string) => void mocks.kv.set(key, value),
  },
  usageRepo: {
    add: (row: Record<string, unknown>) => void mocks.usage.push(row),
    prune: () => {},
  },
}));

vi.mock("@/lib/push", () => ({
  sendPushToAll: async (payload: unknown) => void mocks.pushes.push(payload),
}));

const { openaiAdapter, toOpenAiMessages, lowEffortCutsSpend, GEMINI_SKIP_SIGNATURE } = await import("@/lib/ai/openai");
const { anthropicAdapter, anthropicSystem } = await import("@/lib/ai/anthropic");
const { fallbackConfig, recordFallback, refreshFallbackModel, testProvider } = await import("@/lib/ai/adapters");
const { ANTHROPIC_BASE, GEMINI_BASE, OPENAI_BASE, OUT_OF_TOKENS } = await import("@/lib/ai/provider");
type ProviderConfig = import("@/lib/ai/provider").ProviderConfig;
type LlmTurn = import("@/lib/ai/provider").LlmTurn;

const baseAi = (over: Partial<AISettings> = {}): AISettings => ({
  provider: "openai",
  model: "gpt-5-mini",
  openaiModel: "gpt-5-mini",
  anthropicModel: "",
  geminiModel: "",
  openaiKey: "",
  anthropicKey: "",
  customBaseUrl: "",
  customKey: "",
  customModel: "",
  fallbackProvider: "",
  fallbackModel: "",
  fallbackModelPinned: "",
  ...over,
});

// ── a scripted provider ───────────────────────────────────────────────────

type Reply = { status?: number; json?: unknown; text?: string; sse?: unknown[] };
const sent: Array<{ url: string; body: Record<string, unknown> | null }> = [];
let replies: Array<Reply | (() => Reply)> = [];

function sseBody(frames: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(`data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`));
      controller.close();
    },
  });
}

beforeEach(() => {
  sent.length = 0;
  replies = [];
  mocks.usage.length = 0;
  mocks.pushes.length = 0;
  mocks.kv.clear();
  mocks.app = { tz: "America/New_York", ai: baseAi() };
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.GEMINI_API_KEY = "gm-test";
  process.env.CUSTOM_AI_API_KEY = "cu-test";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      const next = replies.shift();
      if (!next) throw new Error(`unexpected request to ${String(url)}`);
      const r = typeof next === "function" ? next() : next;
      if (r.sse) return new Response(sseBody(r.sse), { status: 200 });
      return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.CUSTOM_AI_API_KEY;
});

const gemini: ProviderConfig = { kind: "gemini", baseUrl: GEMINI_BASE, apiKey: "gm-test", model: "gemini-3.8-pro" };
const openai: ProviderConfig = { kind: "openai", baseUrl: OPENAI_BASE, apiKey: "sk-test", model: "gpt-5.6-terra" };
const custom: ProviderConfig = { kind: "custom", baseUrl: "https://llm.local/v1", apiKey: "cu-test", model: "llama" };

const SIG = { google: { thought_signature: "SIG_A" } };

// ── Gemini thought signatures ─────────────────────────────────────────────

describe("toOpenAiMessages and Gemini's thought signatures", () => {
  type Kind = "openai" | "anthropic" | "gemini" | "custom";
  const step = (origin: Kind, extra?: Record<string, unknown>): LlmTurn[] => [
    { role: "user", text: "add milk and mark dentist done" },
    {
      role: "assistant",
      text: "",
      toolCalls: [
        { id: "fc_1", name: "create_task", args: '{"title":"milk"}', origin, ...(extra ? { extraContent: extra } : {}) },
        { id: "fc_2", name: "complete_task", args: '{"id":"t1"}', origin },
      ],
    },
    { role: "toolResults", results: [{ id: "fc_1", name: "create_task", content: "{}" }, { id: "fc_2", name: "complete_task", content: "{}" }] },
  ];
  const toolCalls = (messages: unknown[]) =>
    (messages[2] as { tool_calls: Array<Record<string, unknown>> }).tool_calls;
  const noneCarry = (calls: Array<Record<string, unknown>>) => calls.every((c) => !("extra_content" in c));

  it("echoes Gemini's signature to Gemini, on the call that carried it and only there", () => {
    const calls = toolCalls(toOpenAiMessages("SYS", step("gemini", SIG), "gemini"));
    expect(calls[0].extra_content).toEqual(SIG);
    expect(calls[1]).not.toHaveProperty("extra_content");
  });

  it("echoes a custom host's own extra data back to that host", () => {
    expect(toolCalls(toOpenAiMessages("SYS", step("custom", SIG), "custom"))[0].extra_content).toEqual(SIG);
  });

  it("never hands one provider's data to another after a failover", () => {
    // a strict host (Mistral, OpenAI) rejects fields it doesn't know
    expect(noneCarry(toolCalls(toOpenAiMessages("SYS", step("gemini", SIG), "custom")))).toBe(true);
    expect(noneCarry(toolCalls(toOpenAiMessages("SYS", step("gemini", SIG), "openai")))).toBe(true);
    expect(noneCarry(toolCalls(toOpenAiMessages("SYS", step("gemini", SIG))))).toBe(true);
  });

  it("gives Gemini its documented placeholder for a step another provider took", () => {
    for (const other of ["openai", "anthropic", "custom"] as const) {
      const calls = toolCalls(toOpenAiMessages("SYS", step(other, other === "custom" ? SIG : undefined), "gemini"));
      expect(calls[0].extra_content).toEqual(GEMINI_SKIP_SIGNATURE);
      expect(calls[1]).not.toHaveProperty("extra_content");
    }
    // and for one of its own that came back unsigned
    expect(toolCalls(toOpenAiMessages("SYS", step("gemini"), "gemini"))[0].extra_content).toEqual(GEMINI_SKIP_SIGNATURE);
    // nothing is invented for anyone else
    expect(noneCarry(toolCalls(toOpenAiMessages("SYS", step("openai"), "custom")))).toBe(true);
  });
});

describe("streaming through the OpenAI-compatible adapter", () => {
  const round0 = [
    {
      choices: [
        {
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "fc_1",
                type: "function",
                function: { name: "create_task", arguments: '{"title":"milk"}' },
                extra_content: SIG,
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 3000, completion_tokens: 5 },
    },
    {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 1, id: "fc_2", type: "function", function: { name: "complete_task", arguments: '{"id":"t1"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 3000, completion_tokens: 20 },
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3000, completion_tokens: 25 } },
    "[DONE]",
  ];

  const run = (turns: LlmTurn[], cfg: ProviderConfig = gemini) =>
    openaiAdapter.stream({ cfg, system: "SYS", turns, tools: [], onText: () => {}, signal: AbortSignal.timeout(5000), feature: "chat" });

  const afterRound0 = async (): Promise<LlmTurn[]> => {
    replies.push({ sse: round0 });
    const turns: LlmTurn[] = [{ role: "user", text: "add milk and mark dentist done" }];
    const first = await run(turns);
    turns.push({ role: "assistant", text: first.text, toolCalls: first.toolCalls });
    turns.push({
      role: "toolResults",
      results: first.toolCalls.map((c) => ({ id: c.id, name: c.name, content: '{"ok":true}' })),
    });
    return turns;
  };
  const sentToolCalls = (n: number) => {
    const messages = sent[n].body?.messages as Array<Record<string, unknown>>;
    return (messages.find((m) => m.role === "assistant") as { tool_calls: Array<Record<string, unknown>> }).tool_calls;
  };

  it("keeps Gemini's signature, and says which provider made each call", async () => {
    replies.push({ sse: round0 });
    const first = await run([{ role: "user", text: "add milk and mark dentist done" }]);
    expect(first.toolCalls).toEqual([
      { id: "fc_1", name: "create_task", args: '{"title":"milk"}', origin: "gemini", extraContent: SIG },
      { id: "fc_2", name: "complete_task", args: '{"id":"t1"}', origin: "gemini" },
    ]);
  });

  it("sends the signature back to Gemini on the next round", async () => {
    const turns = await afterRound0();
    replies.push({ sse: [{ choices: [{ delta: { content: "Done." } }] }, "[DONE]"] });
    expect((await run(turns)).text).toBe("Done.");
    expect(sentToolCalls(1)[0].extra_content).toEqual(SIG);
  });

  it("keeps it from a custom backup that takes over mid-turn", async () => {
    const turns = await afterRound0();
    replies.push({ sse: [{ choices: [{ delta: { content: "Done." } }] }, "[DONE]"] });
    await run(turns, custom);
    expect(sentToolCalls(1).every((c) => !("extra_content" in c))).toBe(true);
  });

  it("records a call's usage once, from the last chunk that reported it", async () => {
    replies.push({ sse: round0 });
    await run([{ role: "user", text: "hi" }]);
    expect(mocks.usage).toHaveLength(1);
    expect(mocks.usage[0]).toMatchObject({ provider: "gemini", inputTokens: 3000, outputTokens: 25, feature: "chat" });
  });

  it("still records what was used when the stream ends in an error", async () => {
    replies.push({ sse: [{ choices: [{ delta: { content: "Hel" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }, { error: { message: "boom" } }] });
    await expect(run([{ role: "user", text: "hi" }])).rejects.toThrow("boom");
    expect(mocks.usage).toHaveLength(1);
  });
});

// ── thinking models and the token cap ─────────────────────────────────────

describe("complete() with models that think before they answer", () => {
  const ask = (cfg: ProviderConfig, maxTokens = 400) =>
    openaiAdapter.complete({ cfg, system: "SYS", prompt: "go", maxTokens, signal: AbortSignal.timeout(5000) });
  const answer = (content: string, finish = "stop") => ({ json: { choices: [{ message: { content }, finish_reason: finish }] } });
  const demandsNewField = {
    status: 400,
    json: { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } },
  };

  const gpt5mini: ProviderConfig = { ...openai, model: "gpt-5-mini" };

  it("gives an OpenAI reasoning model room to think, and low effort where its default is higher", async () => {
    replies.push(demandsNewField, answer("{}"));
    expect(await ask(gpt5mini)).toBe("{}");
    expect(sent[0].body).toMatchObject({ max_tokens: 400 });
    expect(sent[0].body).not.toHaveProperty("reasoning_effort");
    expect(sent[1].body).toMatchObject({ max_completion_tokens: 400 + 4096, reasoning_effort: "low" });
    expect(sent[1].body).not.toHaveProperty("max_tokens");
  });

  it("never raises a later GPT-5 release above its default of none", async () => {
    for (const model of ["gpt-5.1", "gpt-5.4-mini", "gpt-5.6-terra"]) {
      sent.length = 0;
      replies.push(demandsNewField, answer("{}"));
      await ask({ ...openai, model });
      expect(sent[1].body).toMatchObject({ max_completion_tokens: 400 + 4096 });
      expect(sent[1].body).not.toHaveProperty("reasoning_effort");
    }
  });

  it("keeps the room but drops the effort for a model that won't take one", async () => {
    replies.push(
      demandsNewField,
      { status: 400, json: { error: { message: "Unsupported value: 'reasoning_effort' does not support 'low' with this model." } } },
      answer("{}"),
    );
    expect(await ask(gpt5mini)).toBe("{}");
    expect(sent[2].body).toMatchObject({ max_completion_tokens: 400 + 4096 });
    expect(sent[2].body).not.toHaveProperty("reasoning_effort");
  });

  it("gives Gemini room from the first request, and low effort only where its default is higher", async () => {
    replies.push(answer("{}"));
    await ask(gemini);
    expect(sent[0].body).toMatchObject({ max_tokens: 400 + 4096, reasoning_effort: "low" });

    for (const model of ["gemini-2.5-flash-lite", "gemini-3.5-flash-lite", "gemini-flash-latest", "gemini-2.0-flash"]) {
      sent.length = 0;
      replies.push(answer("{}"));
      await ask({ ...gemini, model });
      expect(sent[0].body).toMatchObject({ max_tokens: 400 + 4096 });
      expect(sent[0].body).not.toHaveProperty("reasoning_effort");
    }
  });

  it("asks for low effort only from families whose default is higher", () => {
    const yes: Array<[ProviderConfig["kind"], string]> = [
      ["openai", "gpt-5"],
      ["openai", "gpt-5-mini-2025-08-07"],
      ["openai", "gpt-5-nano"],
      ["openai", "o3"],
      ["openai", "o4-mini"],
      ["gemini", "gemini-2.5-pro"],
      ["gemini", "gemini-2.5-flash"],
      ["gemini", "gemini-2.5-flash-preview-09-2025"],
      ["gemini", "gemini-3-pro-preview"],
      ["gemini", "gemini-3.8-flash"],
      ["gemini", "gemini-4-argon"],
    ];
    const no: Array<[ProviderConfig["kind"], string]> = [
      ["openai", "gpt-5.1"],
      ["openai", "gpt-5.2"],
      ["openai", "gpt-5.4-mini"],
      ["openai", "gpt-5-chat-latest"],
      ["openai", "gpt-4o"],
      ["gemini", "gemini-2.5-flash-lite"],
      ["gemini", "gemini-3.5-flash-lite"],
      ["gemini", "gemini-4-flash-lite"],
      ["gemini", "gemini-2.0-flash"],
      ["gemini", "gemini-pro-latest"],
      ["gemini", "gemini-40-pro"],
      // the same ids on a custom host could be anything
      ["custom", "gpt-5-mini"],
      ["custom", "gemini-3.8-pro"],
      ["anthropic", "o3"],
    ];
    for (const [kind, id] of yes) expect(lowEffortCutsSpend(kind, id), `${kind} ${id}`).toBe(true);
    for (const [kind, id] of no) expect(lowEffortCutsSpend(kind, id), `${kind} ${id}`).toBe(false);
  });

  it("leaves a plain model's request as it was", async () => {
    replies.push(answer("{}"));
    await ask(custom);
    expect(sent[0].body).toMatchObject({ max_tokens: 400 });
    expect(sent[0].body).not.toHaveProperty("reasoning_effort");
    expect(sent).toHaveLength(1);
  });

  it("says so when the whole budget went before any answer", async () => {
    replies.push(answer("", "length"));
    await expect(ask(custom)).rejects.toThrow(OUT_OF_TOKENS);
  });

  it("still returns a partial answer cut off at the cap, for salvage", async () => {
    replies.push(answer('{"tasks":[{"title":"A"},', "length"));
    expect(await ask(custom)).toBe('{"tasks":[{"title":"A"},');
  });

  it("does not loop on a provider that keeps refusing", async () => {
    replies.push({ status: 500, json: { error: { message: "server exploded" } } });
    await expect(ask(openai)).rejects.toThrow("server exploded");
    expect(sent).toHaveLength(1);
  });
});

describe("Anthropic complete() with models that think by default", () => {
  const claude = (model: string): ProviderConfig => ({ kind: "anthropic", baseUrl: ANTHROPIC_BASE, apiKey: "ak", model });
  const ask = (model: string, maxTokens = 400) =>
    anthropicAdapter.complete({
      cfg: claude(model),
      system: "SYS",
      shared: ["RULES", "CONTEXT"],
      prompt: "go",
      maxTokens,
      signal: AbortSignal.timeout(5000),
    });
  const reply = (content: unknown[], stop_reason = "end_turn") => ({
    json: { type: "message", role: "assistant", content, stop_reason, usage: { input_tokens: 40, output_tokens: 5 } },
  });
  const refused = (message: string) => ({ status: 400, json: { type: "error", error: { type: "invalid_request_error", message } } });

  it("gives room and low effort, never touches thinking, and keeps the cached system blocks as they were", async () => {
    replies.push(reply([{ type: "text", text: "{}" }]));
    expect(await ask("claude-test-sonnet")).toBe("{}");
    const body = sent[0].body!;
    expect(body.max_tokens).toBe(400 + 4096);
    expect(body.output_config).toEqual({ effort: "low" });
    expect(body).not.toHaveProperty("thinking");
    expect(JSON.stringify(body.system)).toBe(JSON.stringify(anthropicSystem("SYS", ["RULES", "CONTEXT"])));
  });

  it("drops effort for a model that refuses it, keeps the room, and remembers", async () => {
    replies.push(refused("This model does not support the effort parameter."), reply([{ type: "text", text: "{}" }]));
    expect(await ask("claude-old-a")).toBe("{}");
    expect(sent[1].body).not.toHaveProperty("output_config");
    expect(sent[1].body?.max_tokens).toBe(400 + 4096);

    // the next call goes straight to what works
    replies.push(reply([{ type: "text", text: "{}" }]));
    await ask("claude-old-a");
    expect(sent).toHaveLength(3);
    expect(sent[2].body).not.toHaveProperty("output_config");
  });

  it("falls back to the plain cap on a model with a small output limit", async () => {
    replies.push(
      refused("max_tokens: 4496 > 4096, which is the maximum allowed number of output tokens for claude-old-b"),
      reply([{ type: "text", text: "{}" }]),
    );
    expect(await ask("claude-old-b")).toBe("{}");
    expect(sent[1].body?.max_tokens).toBe(400);
  });

  it("says so when the whole budget went on thinking", async () => {
    replies.push(reply([{ type: "thinking", thinking: "", signature: "x" }], "max_tokens"));
    await expect(ask("claude-test-opus")).rejects.toThrow(OUT_OF_TOKENS);
  });

  it("still returns a partial answer cut off at the cap, for salvage", async () => {
    replies.push(reply([{ type: "thinking", thinking: "" }, { type: "text", text: '{"tasks":[' }], "max_tokens"));
    expect(await ask("claude-test-haiku")).toBe('{"tasks":[');
  });

  it("does not retry other failures", async () => {
    replies.push({ status: 529, json: { type: "error", error: { type: "overloaded_error", message: "Overloaded" } } });
    await expect(ask("claude-test-sonnet")).rejects.toThrow("Overloaded");
    expect(sent).toHaveLength(1);
  });

  it("lets testProvider count a Claude model that ran dry as connected, and say so", async () => {
    process.env.ANTHROPIC_API_KEY = "ak";
    try {
      mocks.app.ai = baseAi({ provider: "anthropic", model: "claude-test-sonnet" });
      replies.push(reply([{ type: "thinking", thinking: "" }], "max_tokens"));
      const r = await testProvider("anthropic");
      expect(r.ok).toBe(true);
      expect(r.message).toMatch(/^claude-test-sonnet responded, but used its whole token budget thinking/);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

describe("testProvider", () => {
  it("allows a real budget", async () => {
    replies.push({ json: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] } });
    expect(await testProvider("openai")).toEqual({ ok: true, message: "gpt-5-mini responded" });
    expect(sent[0].body).toMatchObject({ max_tokens: 256 });
  });

  it("counts a reply cut off at the cap as connected, but says what that means", async () => {
    replies.push({ json: { choices: [{ message: { content: "" }, finish_reason: "length" }] } });
    expect(await testProvider("openai")).toEqual({
      ok: true,
      message: "gpt-5-mini responded, but used its whole token budget thinking — replies may come back empty",
    });
  });

  it("still fails a reply that is simply empty", async () => {
    replies.push({ json: { choices: [{ message: { content: "" }, finish_reason: "stop" }] } });
    expect((await testProvider("openai")).ok).toBe(false);
  });
});

// ── the backup's model ────────────────────────────────────────────────────

describe("refreshFallbackModel", () => {
  const list = { json: { data: [{ id: "gpt-4o", created: 1 }, { id: "gpt-5.6-terra", created: 2 }] } };

  it("resolves an unpinned backup to that provider's newest", async () => {
    mocks.app.ai = baseAi({ provider: "anthropic", model: "claude-x", fallbackProvider: "openai" });
    replies.push(list);
    expect(await refreshFallbackModel()).toBe("gpt-5.6-terra");
    expect(mocks.app.ai.fallbackModel).toBe("gpt-5.6-terra");
  });

  it("does not write a listing onto a backup that changed while it was loading", async () => {
    mocks.app.ai = baseAi({ provider: "anthropic", model: "claude-x", fallbackProvider: "openai" });
    replies.push(() => {
      mocks.app.ai = { ...mocks.app.ai, fallbackProvider: "gemini", fallbackModel: "" };
      return list;
    });
    // what comes back still belongs to the provider that was listed
    expect(await refreshFallbackModel()).toBe("gpt-5.6-terra");
    expect(mocks.app.ai.fallbackProvider).toBe("gemini");
    expect(mocks.app.ai.fallbackModel).toBe("");
  });

  it("never pairs one provider's config with another's model in that window", async () => {
    mocks.app.ai = baseAi({ provider: "anthropic", model: "claude-x", fallbackProvider: "openai" });
    replies.push(() => {
      mocks.app.ai = { ...mocks.app.ai, fallbackProvider: "gemini", fallbackModel: "gemini-3.8-pro" };
      return list;
    });
    const cfg = await fallbackConfig();
    expect(cfg?.kind).toBe("openai");
    expect(cfg?.model).toBe("gpt-5.6-terra");
  });

  it("does not move a backup that was pinned while it was loading", async () => {
    mocks.app.ai = baseAi({ provider: "anthropic", model: "claude-x", fallbackProvider: "openai" });
    replies.push(() => {
      mocks.app.ai = { ...mocks.app.ai, fallbackModelPinned: "gpt-4o", fallbackModel: "gpt-4o" };
      return list;
    });
    expect(await refreshFallbackModel()).toBe("gpt-4o");
    expect(mocks.app.ai.fallbackModel).toBe("gpt-4o");
  });

  it("uses a custom backup's own model id instead of its host's newest listing", async () => {
    mocks.app.ai = baseAi({
      fallbackProvider: "custom",
      customBaseUrl: "https://llm.local/v1",
      customModel: "llama-3.3-70b",
      fallbackModel: "nomic-embed-text",
    });
    expect((await fallbackConfig())?.model).toBe("llama-3.3-70b");
    expect(await refreshFallbackModel()).toBe("llama-3.3-70b");
    expect(mocks.app.ai.fallbackModel).toBe("llama-3.3-70b");
    expect(sent).toHaveLength(0);
  });

  it("uses a pinned backup model exactly as pinned", async () => {
    mocks.app.ai = baseAi({
      fallbackProvider: "custom",
      customBaseUrl: "https://llm.local/v1",
      customModel: "llama-3.3-70b",
      fallbackModel: "llama-3.3-70b",
      fallbackModelPinned: "qwen-72b",
    });
    expect((await fallbackConfig())?.model).toBe("qwen-72b");
    expect(await refreshFallbackModel()).toBe("qwen-72b");
  });
});

// ── telling the owner ─────────────────────────────────────────────────────

describe("the key alert", () => {
  const backup: ProviderConfig = { ...openai, model: "gpt-5-mini" };
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("is sent at most once a day by your clock, not UTC's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 19:57 in New York, three minutes before UTC's day turns over
    vi.setSystemTime(new Date("2026-10-27T23:57:00Z"));
    recordFallback("anthropic", backup, "invalid x-api-key");
    await vi.waitFor(() => expect(mocks.pushes).toHaveLength(1));

    // 20:03 in New York: a new UTC day, the same local one
    vi.setSystemTime(new Date("2026-10-28T00:03:00Z"));
    recordFallback("anthropic", backup, "invalid x-api-key");
    await settle();
    expect(mocks.pushes).toHaveLength(1);

    // the next morning
    vi.setSystemTime(new Date("2026-10-28T13:00:00Z"));
    recordFallback("anthropic", backup, "invalid x-api-key");
    await vi.waitFor(() => expect(mocks.pushes).toHaveLength(2));
  });

  it("stays quiet about a rate limit, Gemini's included", async () => {
    recordFallback("anthropic", backup, "Provider rate limit reached (HTTP 429)");
    recordFallback(
      "gemini",
      backup,
      "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. Please retry in 39.5s.",
    );
    await settle();
    expect(mocks.pushes).toHaveLength(0);
  });
});
