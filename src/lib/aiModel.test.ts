import { describe, expect, it } from "vitest";

/**
 * A model id only means something to the provider it came from, so switching
 * providers has to park one pick and restore the other. These mirror the
 * rules the settings route applies.
 */
type Provider = "openai" | "anthropic" | "custom";
interface Ai {
  provider: Provider;
  model: string;
  openaiModel: string;
  anthropicModel: string;
  customModel: string;
}

function remember(ai: Ai, provider: Provider, model: string): Ai {
  if (provider === "openai") return { ...ai, openaiModel: model };
  if (provider === "anthropic") return { ...ai, anthropicModel: model };
  return { ...ai, customModel: model };
}

function recall(ai: Ai, provider: Provider): string {
  if (provider === "openai") return ai.openaiModel;
  if (provider === "anthropic") return ai.anthropicModel;
  return ai.customModel;
}

/** What the settings route does with an incoming ai patch. */
function applyPatch(ai: Ai, patch: Partial<Ai>): Ai {
  let next = { ...ai };
  if (patch.provider !== undefined && patch.provider !== ai.provider) {
    next = remember(next, ai.provider, ai.model);
    next.provider = patch.provider;
    next.model = recall(next, patch.provider);
  } else if (patch.model !== undefined) {
    next.model = patch.model;
    next = remember(next, ai.provider, patch.model);
  }
  return next;
}

const start: Ai = {
  provider: "openai",
  model: "gpt-5-mini",
  openaiModel: "gpt-5-mini",
  anthropicModel: "",
  customModel: "",
};

describe("switching providers", () => {
  it("does not carry one provider's model id to another", () => {
    const next = applyPatch(start, { provider: "anthropic" });
    expect(next.model).not.toBe("gpt-5-mini");
  });

  it("parks the outgoing pick and gives it back on return", () => {
    const onAnthropic = applyPatch(start, { provider: "anthropic" });
    const chosen = applyPatch(onAnthropic, { model: "claude-haiku-4-5" });
    const backOnOpenAi = applyPatch(chosen, { provider: "openai" });
    expect(backOnOpenAi.model).toBe("gpt-5-mini");
    const backAgain = applyPatch(backOnOpenAi, { provider: "anthropic" });
    expect(backAgain.model).toBe("claude-haiku-4-5");
  });

  it("asks for auto-pick on a provider you have never chosen one for", () => {
    expect(applyPatch(start, { provider: "anthropic" }).model).toBe("");
  });

  it("seeds the memory of a provider used before any of this existed", () => {
    const legacy: Ai = { ...start, openaiModel: "", anthropicModel: "", customModel: "" };
    const next = applyPatch(legacy, { provider: "anthropic" });
    expect(next.openaiModel).toBe("gpt-5-mini");
  });

  it("remembers a model the moment you pick it", () => {
    const next = applyPatch(start, { model: "gpt-5-nano" });
    expect(next.model).toBe("gpt-5-nano");
    expect(next.openaiModel).toBe("gpt-5-nano");
  });

  it("treats auto-pick as a real choice worth remembering", () => {
    const auto = applyPatch(start, { model: "" });
    expect(auto.openaiModel).toBe("");
    const away = applyPatch(auto, { provider: "anthropic" });
    expect(applyPatch(away, { provider: "openai" }).model).toBe("");
  });

  it("keeps custom on its own model, as it always did", () => {
    const onCustom = applyPatch(start, { provider: "custom" });
    const chosen = applyPatch(onCustom, { model: "local-llama" });
    expect(chosen.customModel).toBe("local-llama");
    expect(applyPatch(chosen, { provider: "openai" }).model).toBe("gpt-5-mini");
  });

  it("leaves everything alone when the provider is re-sent unchanged", () => {
    expect(applyPatch(start, { provider: "openai" })).toEqual(start);
  });
});
