import { describe, expect, it } from "vitest";
import { chunkForSpeech } from "./useTTS";

describe("chunkForSpeech", () => {
  it("returns nothing for blank text", () => {
    expect(chunkForSpeech("")).toEqual([]);
    expect(chunkForSpeech("   \n ")).toEqual([]);
  });

  it("keeps decimals, prices, times and domains whole", () => {
    const text = "CVS is 0.3 mi away. It costs $4.99. Meeting at 3:30 p.m. today. See example.com v1.2.3";
    expect(chunkForSpeech(text)).toEqual([text]);
  });

  it("never adds a space that wasn't in the text", () => {
    const text = "First.Second? Third!Fourth… done.";
    expect(chunkForSpeech(text).join(" ")).toBe(text);
  });

  it("collapses runs of whitespace", () => {
    expect(chunkForSpeech("One.\n\n  Two.")).toEqual(["One. Two."]);
  });

  it("splits between sentences, not inside a number", () => {
    const first = `${"a".repeat(30)} is 0.3 mi away.`;
    const second = `${"b".repeat(30)} costs $4.99.`;
    const chunks = chunkForSpeech(`${first} ${second}`, 50);
    expect(chunks).toEqual([first, second]);
  });

  it("keeps punctuation runs and leading punctuation", () => {
    expect(chunkForSpeech("Wait... what?! ...and then")).toEqual(["Wait... what?! ...and then"]);
  });

  it("breaks an overlong sentence at spaces and keeps every word", () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i}`);
    const text = `${words.join(" ")}.`;
    const chunks = chunkForSpeech(text, 50);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(50);
    expect(chunks.join(" ")).toBe(text);
  });

  it("hard-splits a single word longer than the limit", () => {
    const chunks = chunkForSpeech("x".repeat(25), 10);
    expect(chunks).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  it("packs short sentences up to the limit", () => {
    const chunks = chunkForSpeech("One. Two. Three. Four.", 10);
    expect(chunks).toEqual(["One. Two.", "Three.", "Four."]);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(10);
  });

  it("stays fast on long punctuation runs", () => {
    const text = `${"!".repeat(5000)} ${"a.".repeat(5000)} ${"Ok. ".repeat(2000)}`;
    const started = Date.now();
    const chunks = chunkForSpeech(text);
    expect(Date.now() - started).toBeLessThan(500);
    // Single words longer than the limit are hard-split, so compare without spaces.
    expect(chunks.join("").replace(/ /g, "")).toBe(text.replace(/ /g, ""));
  });
});
