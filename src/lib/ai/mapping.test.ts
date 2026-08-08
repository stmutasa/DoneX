import { describe, expect, it } from "vitest";
import type { ChatStreamEvent } from "@/lib/types";
import { isoWeekKey } from "@/lib/utils";
import { SseDecoder, parseSseBlock, sseFrame } from "@/lib/ai/sse";
import { extractJsonObject } from "@/lib/ai/json";
import { cleanProviderMessage } from "@/lib/ai/provider";
import { isoWeekRange } from "@/lib/ai/generate";
import { conversationTitleFrom, historyTurns } from "@/lib/ai/chat";
import { toAnthropicMessages } from "@/lib/ai/anthropic";
import {
  isChatCapableModelId,
  mergeToolName,
  selectOpenAiModels,
  toOpenAiMessages,
} from "@/lib/ai/openai";
import {
  TOOLS,
  findTool,
  normalizePlanBlocks,
  parseDueInput,
  toAnthropicTools,
  toOpenAiTools,
} from "@/lib/ai/tools";

function msg(
  id: string,
  role: "user" | "assistant",
  text: string
): import("@/lib/types").ChatMessageRecord {
  return { id, conversationId: "c1", role, text, activity: [], createdAt: "2026-08-08T10:00:00Z" };
}

const EXPECTED_TOOLS = [
  "create_task",
  "update_task",
  "complete_task",
  "delete_task",
  "list_tasks",
  "create_project",
  "add_note",
  "append_checklist",
  "list_notes",
  "get_calendar_today",
  "get_stats",
  "save_day_plan",
];

describe("tool schema mapping", () => {
  it("exposes exactly the contracted tool set", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(EXPECTED_TOOLS);
  });

  it("maps every tool into OpenAI function-calling shape", () => {
    const mapped = toOpenAiTools(TOOLS);
    expect(mapped).toHaveLength(TOOLS.length);
    for (const [i, entry] of mapped.entries()) {
      expect(entry.type).toBe("function");
      expect(entry.function.name).toBe(TOOLS[i].name);
      expect(entry.function.description.length).toBeGreaterThan(10);
      expect(entry.function.parameters.type).toBe("object");
      expect(entry.function.parameters.properties).toBeTypeOf("object");
    }
  });

  it("maps every tool into Anthropic input_schema shape", () => {
    const mapped = toAnthropicTools(TOOLS);
    expect(mapped.map((t) => t.name)).toEqual(EXPECTED_TOOLS);
    for (const [i, entry] of mapped.entries()) {
      expect(entry.input_schema.type).toBe("object");
      expect(entry.input_schema.properties).toBeTypeOf("object");
      expect(entry.description).toBe(TOOLS[i].description);
      expect(entry).not.toHaveProperty("parameters");
    }
  });

  it("keeps required fields identical across both formats", () => {
    const openai = toOpenAiTools(TOOLS);
    const anthropic = toAnthropicTools(TOOLS);
    for (let i = 0; i < TOOLS.length; i++) {
      expect(anthropic[i].input_schema.required).toEqual(openai[i].function.parameters.required);
    }
  });

  it("gives empty-parameter tools a properties bag both providers accept", () => {
    const stats = toOpenAiTools([findTool("get_stats")!])[0];
    expect(stats.function.parameters).toEqual({ type: "object", properties: {} });
  });

  it("declares create_task with a required title and a recurrence object", () => {
    const spec = findTool("create_task")!;
    expect(spec.parameters.required).toEqual(["title"]);
    expect(spec.parameters.properties?.recurrence?.properties?.freq?.enum).toEqual([
      "daily",
      "weekly",
      "monthly",
      "yearly",
    ]);
    expect(spec.mutating).toBe(true);
  });

  it("marks read-only tools as non-mutating", () => {
    for (const name of ["list_tasks", "list_notes", "get_calendar_today", "get_stats"]) {
      expect(findTool(name)!.mutating).toBe(false);
    }
  });
});

describe("SSE frame encoding", () => {
  it("emits exactly one `data:` line terminated by a blank line", () => {
    const frame = sseFrame({ type: "token", text: "hi" });
    expect(frame).toBe('data: {"type":"token","text":"hi"}\n\n');
  });

  it("keeps newlines inside the JSON payload rather than the frame", () => {
    const frame = sseFrame({ type: "token", text: "a\nb" });
    expect(frame.split("\n\n")).toHaveLength(2);
    expect(frame.startsWith("data: ")).toBe(true);
    const decoded: unknown = JSON.parse(frame.slice(6, -2));
    expect(decoded).toEqual({ type: "token", text: "a\nb" });
  });

  it("round-trips every ChatStreamEvent variant", () => {
    const events: ChatStreamEvent[] = [
      { type: "token", text: "…" },
      { type: "tool", label: "Added “Buy milk” · tomorrow 3:00 PM", status: "start" },
      { type: "tool", label: "Added “Buy milk”", status: "ok" },
      { type: "done", messageId: "m1", conversationId: "c1", text: "ok", activity: [] },
      { type: "error", message: "No AI provider configured" },
    ];
    for (const event of events) {
      const frame = sseFrame(event);
      expect(frame.endsWith("\n\n")).toBe(true);
      expect(JSON.parse(frame.replace(/^data: /, "").trimEnd())).toEqual(event);
    }
  });
});

describe("upstream SSE parsing", () => {
  it("splits frames arriving across chunk boundaries", () => {
    const decoder = new SseDecoder();
    expect(decoder.push('data: {"a":')).toEqual([]);
    expect(decoder.push('1}\n\ndata: [DONE]\n\n')).toEqual([
      { event: "", data: '{"a":1}' },
      { event: "", data: "[DONE]" },
    ]);
  });

  it("reads Anthropic named events and CRLF frames", () => {
    const decoder = new SseDecoder();
    const out = decoder.push(
      "event: content_block_delta\r\ndata: {\"type\":\"content_block_delta\"}\r\n\r\n"
    );
    expect(out).toEqual([
      { event: "content_block_delta", data: '{"type":"content_block_delta"}' },
    ]);
  });

  it("joins multi-line data fields and ignores comments", () => {
    expect(parseSseBlock(": ping\ndata: one\ndata: two")).toEqual({ event: "", data: "one\ntwo" });
  });

  it("flushes a trailing frame that never got its blank line", () => {
    const decoder = new SseDecoder();
    expect(decoder.push("data: tail")).toEqual([]);
    expect(decoder.flush()).toEqual([{ event: "", data: "tail" }]);
  });
});

describe("tool-call name accumulation", () => {
  it("appends genuine fragments but ignores repeated whole names", () => {
    expect(mergeToolName("", "create")).toBe("create");
    expect(mergeToolName("create", "_task")).toBe("create_task");
    expect(mergeToolName("create_task", "create_task")).toBe("create_task");
    expect(mergeToolName("create_task", "")).toBe("create_task");
  });
});

describe("model registry filtering", () => {
  it("keeps chat models and drops non-chat endpoints", () => {
    expect(isChatCapableModelId("gpt-4o")).toBe(true);
    expect(isChatCapableModelId("chatgpt-4o-latest")).toBe(true);
    expect(isChatCapableModelId("o3-mini")).toBe(true);
    expect(isChatCapableModelId("text-embedding-3-large")).toBe(false);
    expect(isChatCapableModelId("whisper-1")).toBe(false);
    expect(isChatCapableModelId("gpt-4o-realtime-preview")).toBe(false);
    expect(isChatCapableModelId("dall-e-3")).toBe(false);
    expect(isChatCapableModelId("omni-moderation-latest")).toBe(false);
  });

  it("sorts by created desc, then reverse lexicographically", () => {
    const sorted = selectOpenAiModels(
      [
        { id: "gpt-4o", created: 100 },
        { id: "gpt-5", created: 300 },
        { id: "gpt-4.1", created: 200 },
      ],
      true
    );
    expect(sorted.map((m) => m.id)).toEqual(["gpt-5", "gpt-4.1", "gpt-4o"]);

    const lexical = selectOpenAiModels(
      [
        { id: "llama-3", created: null },
        { id: "zephyr", created: null },
      ],
      false
    );
    expect(lexical.map((m) => m.id)).toEqual(["zephyr", "llama-3"]);
  });

  it("keeps every id for custom OpenAI-compatible hosts", () => {
    const models = selectOpenAiModels([{ id: "local/whisper-tuned", created: null }], false);
    expect(models).toEqual([{ id: "local/whisper-tuned", label: "local/whisper-tuned" }]);
  });
});

describe("argument coercion", () => {
  it("reads bare dates as all-day local days", () => {
    expect(parseDueInput("2026-08-09", "America/New_York")).toEqual({
      dueAt: "2026-08-09T04:00:00.000Z",
      allDay: true,
    });
  });

  it("reads zone-less datetimes as wall-clock time in the user tz", () => {
    expect(parseDueInput("2026-08-09T15:00", "America/New_York")).toEqual({
      dueAt: "2026-08-09T19:00:00.000Z",
      allDay: false,
    });
  });

  it("passes zoned timestamps through untouched", () => {
    expect(parseDueInput("2026-08-09T19:00:00Z", "America/New_York")).toEqual({
      dueAt: "2026-08-09T19:00:00.000Z",
      allDay: false,
    });
  });

  it("treats null and junk as no due date, and absent as untouched", () => {
    expect(parseDueInput(null, "UTC")).toEqual({ dueAt: null, allDay: false });
    expect(parseDueInput("someday", "UTC")).toEqual({ dueAt: null, allDay: false });
    expect(parseDueInput(undefined, "UTC")).toBeUndefined();
  });

  it("normalises plan blocks and drops malformed ones", () => {
    const blocks = normalizePlanBlocks([
      { start: "9:00", end: "09:45", label: "Deep work", taskIds: ["t1"], kind: "focus" },
      { start: "08:00", end: "08:15", label: "Coffee", kind: "break" },
      { start: "nope", end: "10:00", label: "Broken", kind: "focus" },
      { start: "11:00", end: "11:30", label: "Odd kind", kind: "nap" },
    ]);
    expect(blocks).toEqual([
      { start: "08:00", end: "08:15", label: "Coffee", taskIds: [], kind: "break" },
      { start: "09:00", end: "09:45", label: "Deep work", taskIds: ["t1"], kind: "focus" },
      { start: "11:00", end: "11:30", label: "Odd kind", taskIds: [], kind: "focus" },
    ]);
  });
});

describe("JSON extraction from model replies", () => {
  it("unwraps markdown fences", () => {
    expect(extractJsonObject('```json\n{"greeting":"Hi"}\n```')).toEqual({ greeting: "Hi" });
  });

  it("slices from the first brace to the last", () => {
    expect(extractJsonObject('Sure!\n{"a":{"b":1}}\nHope that helps.')).toEqual({ a: { b: 1 } });
  });

  it("returns null when there is no object", () => {
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject("[1,2,3]")).toBeNull();
  });
});

describe("conversation turn mapping", () => {
  const turns = historyTurns([
    msg("a", "assistant", "orphan opener"),
    msg("b", "user", "add milk"),
    msg("c", "assistant", "Added it."),
    msg("d", "assistant", "Anything else?"),
    msg("e", "user", "   "),
    msg("f", "user", "no thanks"),
  ]);

  it("drops leading assistant turns, blanks, and merges same-role runs", () => {
    expect(turns).toEqual([
      { role: "user", text: "add milk" },
      { role: "assistant", text: "Added it.\n\nAnything else?", toolCalls: [] },
      { role: "user", text: "no thanks" },
    ]);
  });

  it("renders tool calls and results in OpenAI shape", () => {
    const messages = toOpenAiMessages("SYS", [
      { role: "user", text: "add milk" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "call_1", name: "create_task", args: '{"title":"Buy milk"}' }],
      },
      { role: "toolResults", results: [{ id: "call_1", name: "create_task", content: '{"ok":1}' }] },
    ]);
    expect(messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "add milk" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "create_task", arguments: '{"title":"Buy milk"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"ok":1}' },
    ]);
  });

  it("renders tool calls and results in Anthropic block shape", () => {
    const messages = toAnthropicMessages([
      { role: "user", text: "add milk" },
      {
        role: "assistant",
        text: "On it.",
        toolCalls: [{ id: "toolu_1", name: "create_task", args: '{"title":"Buy milk"}' }],
      },
      { role: "toolResults", results: [{ id: "toolu_1", name: "create_task", content: '{"ok":1}' }] },
    ]);
    expect(messages).toEqual([
      { role: "user", content: "add milk" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "On it." },
          { type: "tool_use", id: "toolu_1", name: "create_task", input: { title: "Buy milk" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: '{"ok":1}' }] },
    ]);
  });

  it("never emits an empty Anthropic text block", () => {
    const messages = toAnthropicMessages([
      { role: "user", text: "hi" },
      {
        role: "assistant",
        text: "   ",
        toolCalls: [{ id: "t1", name: "get_stats", args: "" }],
      },
    ]);
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "get_stats", input: {} }],
    });
  });

  it("titles a conversation from the first ~40 characters", () => {
    expect(conversationTitleFrom("  buy   milk  ")).toBe("buy milk");
    expect(conversationTitleFrom("x".repeat(60))).toBe(`${"x".repeat(40)}…`);
    expect(conversationTitleFrom("   ")).toBe("New chat");
  });
});

describe("ISO week ranges", () => {
  it("spans Monday to Sunday of the requested week", () => {
    expect(isoWeekRange("2026-W01")).toEqual({ from: "2025-12-29", to: "2026-01-04" });
    expect(isoWeekRange("2026-W32")).toEqual({ from: "2026-08-03", to: "2026-08-09" });
  });

  it("agrees with isoWeekKey for dates across the year", () => {
    for (const day of ["2026-01-01", "2026-03-15", "2026-08-08", "2026-12-31", "2027-01-03"]) {
      const key = isoWeekKey(new Date(`${day}T12:00:00Z`), "UTC");
      const { from, to } = isoWeekRange(key);
      expect(from <= day && day <= to).toBe(true);
      expect(new Date(`${to}T00:00:00Z`).getUTCDay()).toBe(0); // Sunday
      expect(new Date(`${from}T00:00:00Z`).getUTCDay()).toBe(1); // Monday
    }
  });
});

describe("provider error surfacing", () => {
  it("passes the upstream message through verbatim", () => {
    expect(
      cleanProviderMessage(
        400,
        JSON.stringify({ error: { message: "The model `gpt-nope` does not exist" } })
      )
    ).toBe("The model `gpt-nope` does not exist");
    expect(
      cleanProviderMessage(401, JSON.stringify({ error: { message: "invalid x-api-key" } }))
    ).toBe("invalid x-api-key");
  });

  it("falls back to a readable status message for HTML or empty bodies", () => {
    expect(cleanProviderMessage(502, "<html>bad gateway</html>")).toBe(
      "Provider request failed (HTTP 502)"
    );
    expect(cleanProviderMessage(401, "")).toBe("Provider rejected the API key (HTTP 401)");
  });
});
