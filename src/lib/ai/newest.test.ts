import { describe, expect, it } from "vitest";
import { selectOpenAiModels } from "@/lib/ai/openai";

/**
 * The backup model is whatever sits at the head of the provider's list, so
 * "newest first" is the contract the auto-pick depends on.
 */
describe("newest-first ordering (what the backup model auto-picks)", () => {
  it("puts the most recently released model first", () => {
    const picked = selectOpenAiModels(
      [
        { id: "gpt-4o", created: 1_700_000_000 },
        { id: "gpt-5.6-terra", created: 1_800_000_000 },
        { id: "gpt-4.1", created: 1_750_000_000 },
      ],
      true,
    );
    expect(picked[0].id).toBe("gpt-5.6-terra");
  });

  it("never auto-picks a non-chat model as the backup", () => {
    const picked = selectOpenAiModels(
      [
        { id: "text-embedding-3-large", created: 1_900_000_000 },
        { id: "whisper-1", created: 1_899_000_000 },
        { id: "dall-e-3", created: 1_898_000_000 },
        { id: "gpt-5.6-terra", created: 1_800_000_000 },
      ],
      true,
    );
    expect(picked[0].id).toBe("gpt-5.6-terra");
  });

  it("falls back to reverse-lexical when the provider omits timestamps", () => {
    const picked = selectOpenAiModels(
      [
        { id: "gpt-4o", created: null },
        { id: "gpt-5.6-terra", created: null },
      ],
      true,
    );
    expect(picked[0].id).toBe("gpt-5.6-terra");
  });

  it("never auto-picks a model /chat/completions refuses (codex and -pro are Responses-only)", () => {
    const picked = selectOpenAiModels(
      [
        { id: "gpt-5-pro", created: 1_900_000_000 },
        { id: "gpt-5.2-pro-2025-12-11", created: 1_899_000_000 },
        { id: "gpt-5.1-codex-max", created: 1_898_000_000 },
        { id: "gpt-5-codex", created: 1_897_000_000 },
        { id: "o3-pro", created: 1_896_000_000 },
        { id: "o1-pro", created: 1_895_000_000 },
        { id: "codex-mini-latest", created: 1_894_000_000 },
        { id: "o3-deep-research", created: 1_893_000_000 },
        { id: "gpt-5.6-terra", created: 1_800_000_000 },
        { id: "o4-mini", created: 1_700_000_000 },
      ],
      true,
    );
    expect(picked.map((m) => m.id)).toEqual(["gpt-5.6-terra", "o4-mini"]);
  });

  it("returns an empty list rather than a bad pick when nothing qualifies", () => {
    expect(selectOpenAiModels([{ id: "whisper-1", created: 1 }], true)).toEqual([]);
  });
});
