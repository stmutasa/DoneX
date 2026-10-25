import { afterEach, describe, expect, it, vi } from "vitest";
import { selectGeminiModels, GEMINI_ARGON_ID } from "@/lib/ai/openai";
import type { AISettings } from "@/lib/types";

vi.mock("@/lib/db/repos", () => ({ settingsRepo: { getApp: () => ({ ai: {} }) } }));
const { keyFor, KEY_ENV } = await import("@/lib/ai/provider");

const ai = (over: Partial<AISettings> = {}) =>
  ({ openaiKey: "", anthropicKey: "", customKey: "", ...over }) as AISettings;

afterEach(() => {
  for (const v of Object.values(KEY_ENV)) delete process.env[v];
});

describe("keyFor — keys come from Railway", () => {
  it("reads the provider's own variable", () => {
    process.env.OPENAI_API_KEY = "sk-from-railway";
    expect(keyFor("openai", ai())).toEqual({ key: "sk-from-railway", source: "env", storedCopy: false });
  });

  it("prefers Railway over a copy the app stored, and says the copy exists", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-railway";
    expect(keyFor("anthropic", ai({ anthropicKey: "sk-ant-old" }))).toEqual({
      key: "sk-ant-railway",
      source: "env",
      storedCopy: true,
    });
  });

  it("keeps an older stored key working until Railway has one, so nothing breaks on upgrade", () => {
    expect(keyFor("openai", ai({ openaiKey: "sk-old" }))).toEqual({ key: "sk-old", source: "stored", storedCopy: true });
  });

  it("says plainly when there is none", () => {
    expect(keyFor("gemini", ai())).toEqual({ key: "", source: "none", storedCopy: false });
  });

  it("names a variable for every provider", () => {
    expect(KEY_ENV).toEqual({
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      gemini: "GEMINI_API_KEY",
      custom: "CUSTOM_AI_API_KEY",
    });
  });

  it("ignores a variable that is only whitespace", () => {
    process.env.GEMINI_API_KEY = "   ";
    expect(keyFor("gemini", ai()).source).toBe("none");
  });
});

describe("selectGeminiModels", () => {
  const raw = (...ids: string[]) => ids.map((id) => ({ id, created: null }));

  it("keeps chat models, drops embeddings, images and audio, and strips the prefix", () => {
    const ids = selectGeminiModels(
      raw("models/gemini-3.8-flash", "models/text-embedding-005", "models/gemini-embedding-2", "models/imagen-5", "models/gemini-3.8-flash-tts"),
    ).map((m) => m.id);
    expect(ids).toContain("gemini-3.8-flash");
    expect(ids.some((id) => /embedding|imagen|tts/.test(id))).toBe(false);
    expect(ids.some((id) => id.startsWith("models/"))).toBe(false);
  });

  it("names Gemini 4 Argon when Google lists it", () => {
    const list = selectGeminiModels(raw("gemini-3.8-flash", "gemini-4-argon"));
    expect(list.find((m) => m.id === GEMINI_ARGON_ID)?.label).toBe("Gemini 4 Argon");
  });

  it("still offers an Argon slot when this key isn't given it — but last, and saying so", () => {
    const list = selectGeminiModels(raw("gemini-3.8-flash", "gemini-3.8-pro"));
    expect(list.at(-1)).toEqual({ id: "gemini-4-argon", label: "Gemini 4 Argon — not offered to this key yet" });
    // auto-pick and the backup take the head of the list, which must be usable
    expect(list[0].id).not.toBe(GEMINI_ARGON_ID);
  });
});
