import { describe, expect, it } from "vitest";
import { backupCollides, recallModel, rememberModel, resolveAiPatch } from "@/lib/aiModels";
import type { AISettings } from "@/lib/types";

const ai = (over: Partial<AISettings> = {}): AISettings => ({
  provider: "openai",
  model: "gpt-5-mini",
  openaiModel: "gpt-5-mini",
  anthropicModel: "",
  openaiKey: "k",
  anthropicKey: "k",
  customBaseUrl: "",
  customKey: "",
  customModel: "",
  fallbackProvider: "",
  fallbackModel: "",
  ...over,
});

/** What the settings would become after applying a patch. */
const after = (current: AISettings, patch: Partial<AISettings>): AISettings => ({
  ...current,
  ...resolveAiPatch(current, patch),
});

describe("keeping a model with its provider", () => {
  it("does not carry one provider's model id to another", () => {
    expect(after(ai(), { provider: "anthropic" }).model).not.toBe("gpt-5-mini");
  });

  it("parks the outgoing pick and gives it back on return", () => {
    let s = after(ai(), { provider: "anthropic" });
    s = after(s, { model: "claude-haiku-4-5" });
    s = after(s, { provider: "openai" });
    expect(s.model).toBe("gpt-5-mini");
    expect(after(s, { provider: "anthropic" }).model).toBe("claude-haiku-4-5");
  });

  it("asks for auto-pick on a provider you have never chosen one for", () => {
    expect(after(ai(), { provider: "anthropic" }).model).toBe("");
  });

  it("seeds the memory of a provider used before any of this existed", () => {
    const legacy = ai({ openaiModel: "", anthropicModel: "", customModel: "" });
    expect(after(legacy, { provider: "anthropic" }).openaiModel).toBe("gpt-5-mini");
  });

  it("remembers a model the moment you pick it", () => {
    const s = after(ai(), { model: "gpt-5-nano" });
    expect(s.model).toBe("gpt-5-nano");
    expect(s.openaiModel).toBe("gpt-5-nano");
  });

  it("treats auto-pick as a real choice worth remembering", () => {
    let s = after(ai(), { model: "" });
    expect(s.openaiModel).toBe("");
    s = after(s, { provider: "anthropic" });
    expect(after(s, { provider: "openai" }).model).toBe("");
  });

  it("keeps custom on its own model field", () => {
    let s = after(ai(), { provider: "custom" });
    s = after(s, { model: "local-llama" });
    expect(s.customModel).toBe("local-llama");
    expect(after(s, { provider: "openai" }).model).toBe("gpt-5-mini");
  });

  it("lets a model named with the provider win over the remembered one", () => {
    const s = after(ai({ anthropicModel: "claude-old" }), {
      provider: "anthropic",
      model: "claude-new",
    });
    expect(s.model).toBe("claude-new");
    expect(s.anthropicModel).toBe("claude-new");
  });

  it("changes nothing when the provider is re-sent unchanged", () => {
    expect(resolveAiPatch(ai(), { provider: "openai" })).toEqual({ provider: "openai" });
  });
});

describe("a backup that would stand in for itself", () => {
  const withBackup = ai({ fallbackProvider: "anthropic", fallbackModel: "claude-x" });

  it("is dropped when you make that provider the active one", () => {
    const s = after(withBackup, { provider: "anthropic" });
    expect(s.fallbackProvider).toBe("");
    expect(s.fallbackModel).toBe("");
  });

  it("is dropped when picked as a backup for itself", () => {
    expect(after(ai(), { fallbackProvider: "openai" }).fallbackProvider).toBe("");
  });

  it("is left alone when it really does back something else up", () => {
    const s = after(withBackup, { provider: "custom" });
    expect(s.fallbackProvider).toBe("anthropic");
    expect(s.fallbackModel).toBe("claude-x");
  });

  it("survives a change that has nothing to do with it", () => {
    expect(after(withBackup, { model: "gpt-5-nano" }).fallbackProvider).toBe("anthropic");
  });

  it("announces itself before the change is applied", () => {
    expect(backupCollides(withBackup, { provider: "anthropic" })).toBe(true);
    expect(backupCollides(withBackup, { provider: "custom" })).toBe(false);
    expect(backupCollides(ai(), { provider: "anthropic" })).toBe(false);
  });
});

describe("remember and recall", () => {
  it("files each provider's model under that provider", () => {
    expect(rememberModel("openai", "m")).toEqual({ openaiModel: "m" });
    expect(rememberModel("anthropic", "m")).toEqual({ anthropicModel: "m" });
    expect(rememberModel("custom", "m")).toEqual({ customModel: "m" });
  });

  it("reads them back", () => {
    const s = ai({ openaiModel: "a", anthropicModel: "b", customModel: "c" });
    expect(recallModel("openai", s)).toBe("a");
    expect(recallModel("anthropic", s)).toBe("b");
    expect(recallModel("custom", s)).toBe("c");
  });
});
