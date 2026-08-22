import { describe, expect, it } from "vitest";
import { parseBreakdown } from "@/lib/ai/generate";

describe("parseBreakdown", () => {
  it("normalizes a well-formed breakdown", () => {
    const out = parseBreakdown({
      tasks: [
        {
          title: "Renew Maya's passport.",
          notes: "Office is closed Mondays",
          dueAtLocal: "2026-09-15",
          dueKind: "by",
          priority: 2,
          tags: ["#Travel", "docs"],
        },
        { title: "Book airport parking", dueAtLocal: null, dueKind: "on", priority: 0, tags: [] },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      title: "Renew Maya's passport", // trailing punctuation stripped
      notes: "Office is closed Mondays",
      dueAtLocal: "2026-09-15",
      dueKind: "by",
      priority: 2,
      tags: ["travel", "docs"], // # stripped, lowercased, capped at 2
    });
    expect(out[1].dueKind).toBe("on");
  });

  it("drops malformed and titleless entries instead of guessing", () => {
    const out = parseBreakdown({
      tasks: [null, "just a string", { notes: "no title" }, { title: "   " }, { title: "Keep me" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Keep me");
  });

  it("clamps priority, truncates long fields, and caps at 20 tasks", () => {
    const long = "x".repeat(300);
    const out = parseBreakdown({
      tasks: [
        { title: long, notes: long, priority: 9 },
        ...Array.from({ length: 30 }, (_, i) => ({ title: `Task ${i}` })),
      ],
    });
    expect(out).toHaveLength(20);
    expect(out[0].title).toHaveLength(80);
    expect(out[0].notes).toHaveLength(200);
    expect(out[0].priority).toBe(3);
  });

  it("defaults dueKind to 'on' for unknown values and handles missing tasks array", () => {
    expect(parseBreakdown({})).toEqual([]);
    const out = parseBreakdown({ tasks: [{ title: "T", dueKind: "whenever" }] });
    expect(out[0].dueKind).toBe("on");
  });
});
