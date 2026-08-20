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

  it("returns an empty list rather than a bad pick when nothing qualifies", () => {
    expect(selectOpenAiModels([{ id: "whisper-1", created: 1 }], true)).toEqual([]);
  });
});
