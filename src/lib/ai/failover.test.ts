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

  it("stays quiet about trouble that passes on its own", () => {
    expect(needsOwner(cleanProviderMessage(429, ""))).toBe(false);
    expect(needsOwner(cleanProviderMessage(503, ""))).toBe(false);
    expect(needsOwner("The AI provider took too long to respond.")).toBe(false);
  });
});
