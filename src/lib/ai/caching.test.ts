import { describe, expect, it } from "vitest";
import { anthropicSystem } from "@/lib/ai/anthropic";
import { openAiSystem } from "@/lib/ai/openai";
import { triagePrompt } from "@/lib/ai/prompts";

const base = {
  fromLabel: "Ana",
  source: "sms",
  receivedAt: "2026-10-24T14:00:00Z",
  todayKey: "2026-10-24",
  weekday: "Saturday",
  tz: "America/New_York",
  openTasksDigest: "OVERDUE (1)\n- renew the permit",
  projectNames: ["House"],
  tags: ["errands"],
  sentDigest: "(none)",
  feedbackDigest: "",
};

describe("triagePrompt ordering", () => {
  const a = triagePrompt({ ...base, content: "can you grab milk?" });
  const b = triagePrompt({ ...base, content: "your parcel is out for delivery", receivedAt: "2026-10-24T14:03:00Z" });

  it("keeps everything but the item byte-identical between items", () => {
    expect(a.instructions).toBe(b.instructions);
    expect(a.context).toBe(b.context);
    expect(a.item).not.toBe(b.item);
  });

  it("keeps the item, the sender and the arrival time out of the shared part", () => {
    for (const shared of [a.instructions, a.context]) {
      expect(shared).not.toContain("grab milk");
      expect(shared).not.toContain("2026-10-24T14:00:00Z");
      expect(shared).not.toContain("SOURCE:");
    }
    expect(a.item).toContain("grab milk");
    expect(a.item).toContain("SOURCE: sms from Ana");
  });

  it("puts the user's context in the shared part, not the rules", () => {
    expect(a.context).toContain("renew the permit");
    expect(a.instructions).not.toContain("renew the permit");
  });

  it("still carries every rule the model needs", () => {
    expect(a.instructions).toContain("task.dueAtLocal is REQUIRED");
    expect(a.instructions).toContain("Return JSON exactly like");
    expect(a.instructions).toContain("TODAY: 2026-10-24");
  });

  it("is big enough for the providers to bother caching", () => {
    // Anthropic's newest models cache from 512 tokens and OpenAI from 1,024;
    // at roughly four characters a token, the rules alone clear both.
    expect(a.instructions.length / 4).toBeGreaterThan(1024);
  });
});

describe("anthropicSystem", () => {
  it("leaves an uncached call exactly as it was", () => {
    expect(anthropicSystem("be precise")).toBe("be precise");
    expect(anthropicSystem("be precise", ["", "  "])).toBe("be precise");
  });

  it("puts a breakpoint at the end of each shared segment", () => {
    const sys = anthropicSystem("be precise", ["RULES", "CONTEXT"]) as Array<Record<string, unknown>>;
    expect(sys).toEqual([
      { type: "text", text: "be precise" },
      { type: "text", text: "RULES", cache_control: { type: "ephemeral" } },
      { type: "text", text: "CONTEXT", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("never asks for more breakpoints than the API allows", () => {
    const sys = anthropicSystem("s", ["a", "b", "c", "d", "e"]) as Array<Record<string, unknown>>;
    expect(sys.filter((b) => b.cache_control).length).toBe(3);
    expect(sys.at(-1)?.text).toBe("c\n\nd\n\ne");
  });
});

describe("openAiSystem", () => {
  it("leaves an uncached call exactly as it was", () => {
    expect(openAiSystem("be precise")).toBe("be precise");
  });

  it("puts the shared text first, in order, so the prefix repeats", () => {
    expect(openAiSystem("be precise", ["RULES", "CONTEXT"])).toBe("be precise\n\nRULES\n\nCONTEXT");
  });
});
