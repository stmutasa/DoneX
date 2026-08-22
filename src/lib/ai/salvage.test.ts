import { describe, expect, it } from "vitest";
import { extractJsonObject, salvageJson } from "@/lib/ai/json";

const FULL = {
  tasks: [
    { title: "Renew passport", priority: 2 },
    { title: "Book parking", priority: 0 },
    { title: "Call the bank", priority: 1 },
  ],
};

describe("salvageJson / extractJsonObject", () => {
  it("still parses clean payloads and fenced payloads", () => {
    const raw = JSON.stringify(FULL);
    expect(extractJsonObject(raw)).toEqual(FULL);
    expect(extractJsonObject("```json\n" + raw + "\n```")).toEqual(FULL);
    expect(extractJsonObject("Here you go:\n" + raw + "\nHope that helps!")).toEqual(FULL);
  });

  it("recovers a reply truncated mid-object (the token-cap failure)", () => {
    const full = JSON.stringify(FULL);
    const truncated = full.slice(0, full.indexOf('"Call the bank"') + 5); // cut inside 3rd task
    const out = extractJsonObject(truncated);
    expect(out).not.toBeNull();
    const tasks = (out as typeof FULL).tasks;
    expect(tasks.length).toBe(2); // the two complete tasks survive
    expect(tasks[1].title).toBe("Book parking");
  });

  it("recovers a reply truncated right after a comma", () => {
    const truncated = '{"tasks": [{"title": "A", "priority": 1}, {"title": "B", "priority": 0},';
    const tasks = (extractJsonObject(truncated) as typeof FULL).tasks;
    expect(tasks.map((t) => t.title)).toEqual(["A", "B"]);
  });

  it("escapes raw newlines and tabs inside string values", () => {
    const raw = '{"tasks": [{"title": "Fix the\ngarage\tdoor", "priority": 0}]}';
    const out = extractJsonObject(raw) as typeof FULL;
    expect(out.tasks[0].title).toBe("Fix the\ngarage\tdoor");
  });

  it("handles both problems at once — raw newlines AND truncation", () => {
    const raw = '{"tasks": [{"title": "Email the\ncontractor"}, {"title": "Half a tas';
    const out = extractJsonObject(raw) as { tasks: { title: string }[] };
    expect(out.tasks).toHaveLength(1);
    expect(out.tasks[0].title).toBe("Email the\ncontractor");
  });

  it("does not mangle escaped quotes or braces inside strings", () => {
    const raw = '{"a": "he said \\"hi {ok}\\" twice", "b": [1, 2]}';
    expect(extractJsonObject(raw)).toEqual({ a: 'he said "hi {ok}" twice', b: [1, 2] });
  });

  it("returns null when nothing is recoverable", () => {
    expect(salvageJson("no json here at all")).toBeNull();
    expect(extractJsonObject("")).toBeNull();
    expect(extractJsonObject("{")).toBeNull();
  });
});
