import { describe, expect, it } from "vitest";
import { isFailoverWorthy, needsOwner } from "@/lib/ai/adapters";
import { NOT_CONFIGURED, NO_MODEL, cleanProviderMessage } from "@/lib/ai/provider";

describe("isFailoverWorthy", () => {
  it("hands a missing key or model to the backup — that is what a backup is for", () => {
    expect(isFailoverWorthy(NOT_CONFIGURED)).toBe(true);
    expect(isFailoverWorthy(NO_MODEL)).toBe(true);
  });

  it("fails over on the failures that actually strand the user", () => {
    // The four real-world cases: dead key, quota, outage, silence.
    expect(isFailoverWorthy(cleanProviderMessage(401, ""))).toBe(true);
    expect(isFailoverWorthy(cleanProviderMessage(429, ""))).toBe(true);
    expect(isFailoverWorthy(cleanProviderMessage(503, ""))).toBe(true);
    expect(isFailoverWorthy("The AI provider took too long to respond.")).toBe(true);
    expect(isFailoverWorthy("The model did not return valid JSON.")).toBe(true);
  });
});

describe("cleanProviderMessage", () => {
  it("surfaces the provider's own wording when it gives one", () => {
    const msg = cleanProviderMessage(
      401,
      JSON.stringify({ error: { message: "Incorrect API key provided: sk-abc***" } }),
    );
    expect(msg).toContain("Incorrect API key provided");
  });

  it("falls back to a readable summary for empty or HTML bodies", () => {
    expect(cleanProviderMessage(401, "")).toMatch(/rejected the API key/i);
    expect(cleanProviderMessage(429, "")).toMatch(/rate limit/i);
    expect(cleanProviderMessage(503, "<html>502 Bad Gateway</html>")).toMatch(/HTTP 503/);
  });
});

describe("needsOwner", () => {
  it("flags what only the owner can fix", () => {
    expect(needsOwner("OpenAI has no API key saved")).toBe(true);
    expect(needsOwner("OpenAI has no model selected")).toBe(true);
    expect(needsOwner(cleanProviderMessage(401, ""))).toBe(true);
    expect(needsOwner("Incorrect API key provided: sk-abc***")).toBe(true);
  });

  it("recognises Anthropic's and Gemini's own wording for a key or account problem", () => {
    // What cleanProviderMessage leaves of each provider's real error body.
    const anthropic401 = cleanProviderMessage(
      401,
      JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }),
    );
    expect(anthropic401).toBe("invalid x-api-key");
    expect(needsOwner(anthropic401)).toBe(true);
    expect(needsOwner("authentication_error")).toBe(true);
    expect(
      needsOwner("Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."),
    ).toBe(true);
    expect(needsOwner("Your API key does not have permission to use the specified resource.")).toBe(true);

    const gemini400 = cleanProviderMessage(
      400,
      JSON.stringify([
        {
          error: {
            code: 400,
            message: "API key not valid. Please pass a valid API key.",
            status: "INVALID_ARGUMENT",
            details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
          },
        },
      ]),
    );
    expect(gemini400).toBe("API key not valid. Please pass a valid API key.");
    expect(needsOwner(gemini400)).toBe(true);
    expect(needsOwner("API key expired. Please renew the API key.")).toBe(true);
  });

  it("flags an OpenAI account out of credit", () => {
    const openai429 = cleanProviderMessage(
      429,
      JSON.stringify({
        error: {
          message:
            "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.",
          type: "insufficient_quota",
          param: null,
          code: "insufficient_quota",
        },
      }),
    );
    expect(needsOwner(openai429)).toBe(true);
    // the same body with no message still names its type
    expect(needsOwner(cleanProviderMessage(429, JSON.stringify({ error: { type: "insufficient_quota" } })))).toBe(true);
  });

  it("does not flag Gemini's rate limit, which uses the same words", () => {
    const gemini429 = cleanProviderMessage(
      429,
      JSON.stringify([
        {
          error: {
            code: 429,
            message:
              "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/usage?tab=rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-3.8-flash\nPlease retry in 39.5s.",
            status: "RESOURCE_EXHAUSTED",
          },
        },
      ]),
    );
    expect(gemini429).toMatch(/^You exceeded your current quota/);
    expect(needsOwner(gemini429)).toBe(false);
  });

  it("stays quiet about trouble that passes on its own", () => {
    expect(needsOwner(cleanProviderMessage(429, ""))).toBe(false);
    expect(needsOwner(cleanProviderMessage(503, ""))).toBe(false);
    expect(needsOwner("The AI provider took too long to respond.")).toBe(false);
    expect(needsOwner("Overloaded")).toBe(false);
    expect(
      needsOwner("Rate limit reached for gpt-5-mini in organization org-x on tokens per min (TPM): Limit 200000, Used 199500."),
    ).toBe(false);
    expect(needsOwner("The model is overloaded. Please try again later.")).toBe(false);
  });
});
