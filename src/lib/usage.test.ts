import { describe, expect, it } from "vitest";
import { readUsage } from "@/lib/ai/usage";
import {
  companyOf,
  dateKeysBetween,
  formatTokens,
  rollupUsage,
  totalsOf,
  type UsageRow,
} from "@/lib/usage";

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  dateLocal: "2026-09-10",
  provider: "openai",
  model: "gpt-5",
  feature: "triage",
  inputTokens: 100,
  outputTokens: 20,
  ...over,
});

describe("totalsOf", () => {
  it("counts calls and both directions of tokens", () => {
    expect(totalsOf([row(), row({ inputTokens: 50, outputTokens: 5 })])).toEqual({
      calls: 2,
      input: 150,
      output: 25,
      total: 175,
    });
  });

  it("is all zeroes with nothing recorded", () => {
    expect(totalsOf([])).toEqual({ calls: 0, input: 0, output: 0, total: 0 });
  });
});

describe("rollupUsage", () => {
  const rows = [
    row({ provider: "openai", model: "gpt-5", feature: "triage", inputTokens: 300, outputTokens: 100 }),
    row({ provider: "openai", model: "gpt-5", feature: "chat", inputTokens: 100, outputTokens: 100 }),
    row({ provider: "anthropic", model: "claude-fable-5", feature: "briefing", inputTokens: 150, outputTokens: 50 }),
  ];

  it("groups by company, biggest first", () => {
    const { byCompany } = rollupUsage(rows);
    expect(byCompany.map((b) => b.label)).toEqual(["OpenAI", "Anthropic"]);
    expect(byCompany[0]).toMatchObject({ calls: 2, input: 400, output: 200, total: 600 });
    expect(byCompany[1]).toMatchObject({ calls: 1, total: 200 });
  });

  it("gives each bucket its share of the window", () => {
    const { byCompany } = rollupUsage(rows);
    expect(byCompany[0].share).toBeCloseTo(0.75);
    expect(byCompany[1].share).toBeCloseTo(0.25);
  });

  it("groups by model and by feature too", () => {
    const { byModel, byFeature } = rollupUsage(rows);
    expect(byModel.map((b) => b.key)).toEqual(["gpt-5", "claude-fable-5"]);
    expect(byFeature.map((b) => b.label)).toEqual([
      "Inbox triage",
      "Assistant chat",
      "Morning briefing",
    ]);
  });

  it("keeps a custom endpoint distinct from the big two", () => {
    const { byCompany } = rollupUsage([row({ provider: "custom", model: "local-llama" })]);
    expect(byCompany[0].label).toBe("Custom endpoint");
  });

  it("fills quiet days with zero so the chart has no holes", () => {
    const { daily } = rollupUsage(
      [row({ dateLocal: "2026-09-10", inputTokens: 10, outputTokens: 0 })],
      "2026-09-08",
      "2026-09-11",
    );
    expect(daily).toEqual([
      { dateLocal: "2026-09-08", total: 0 },
      { dateLocal: "2026-09-09", total: 0 },
      { dateLocal: "2026-09-10", total: 10 },
      { dateLocal: "2026-09-11", total: 0 },
    ]);
  });

  it("survives an empty window", () => {
    const out = rollupUsage([], "2026-09-09", "2026-09-10");
    expect(out.total).toBe(0);
    expect(out.byCompany).toEqual([]);
    expect(out.daily.map((d) => d.total)).toEqual([0, 0]);
  });

  it("does not divide by zero when nothing was spent", () => {
    const out = rollupUsage([row({ inputTokens: 0, outputTokens: 0 })]);
    expect(out.byCompany[0].share).toBe(0);
  });
});

describe("dateKeysBetween", () => {
  it("is inclusive of both ends", () => {
    expect(dateKeysBetween("2026-09-09", "2026-09-11")).toEqual([
      "2026-09-09",
      "2026-09-10",
      "2026-09-11",
    ]);
  });

  it("crosses a month boundary", () => {
    expect(dateKeysBetween("2026-08-30", "2026-09-02")).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });
});

describe("formatTokens", () => {
  it("reads at a glance", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(812)).toBe("812");
    expect(formatTokens(4310)).toBe("4.3k");
    expect(formatTokens(43_100)).toBe("43k");
    expect(formatTokens(1_240_000)).toBe("1.24M");
    expect(formatTokens(24_000_000)).toBe("24.0M");
  });

  it("never shows a negative or a NaN", () => {
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});

describe("companyOf", () => {
  it("names the two known providers", () => {
    expect(companyOf("openai").label).toBe("OpenAI");
    expect(companyOf("anthropic").label).toBe("Anthropic");
  });
});

describe("readUsage", () => {
  it("reads OpenAI's field names", () => {
    expect(readUsage({ prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 })).toEqual({
      inputTokens: 120,
      outputTokens: 30,
    });
  });

  it("reads Anthropic's field names", () => {
    expect(readUsage({ input_tokens: 90, output_tokens: 12 })).toEqual({
      inputTokens: 90,
      outputTokens: 12,
    });
  });

  it("treats a missing or malformed usage block as zero", () => {
    expect(readUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(readUsage({ prompt_tokens: "lots" })).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
