import { describe, expect, it } from "vitest";
import { composeInboxNotes } from "@/lib/inboxNotes";

const base = {
  content: "Hi — your policy renews on the 20th. Confirm the new premium of $412 or call us.",
  fromLabel: "Ana at Statewide <ana@statewide.example>",
  source: "gmail",
  receivedAt: "2026-09-09T14:03:00.000Z",
};

describe("composeInboxNotes", () => {
  it("leads with the AI's summary of what the sender wanted", () => {
    const notes = composeInboxNotes({
      ...base,
      summary: "Ana needs you to confirm the $412 renewal premium before the 20th.",
    });
    expect(notes.startsWith("Ana needs you to confirm the $412 renewal premium before the 20th."))
      .toBe(true);
  });

  it("records where it came from", () => {
    const notes = composeInboxNotes({ ...base, summary: "Confirm the renewal." });
    expect(notes).toContain("From Ana at Statewide <ana@statewide.example>");
    expect(notes).toContain("email");
    expect(notes).toContain("Sep 9");
  });

  it("keeps the summary and the provenance on separate lines", () => {
    const notes = composeInboxNotes({ ...base, summary: "Confirm the renewal." });
    expect(notes).toBe(
      "Confirm the renewal.\n\nFrom Ana at Statewide <ana@statewide.example> · email · Sep 9",
    );
  });

  it("falls back to an excerpt when the model summarised nothing", () => {
    const notes = composeInboxNotes({ ...base, summary: "" });
    expect(notes).toContain("your policy renews on the 20th");
  });

  it("flattens the wrapped whitespace mail arrives with", () => {
    const notes = composeInboxNotes({
      ...base,
      summary: null,
      content: "Line one\n\nline   two\tline three",
    });
    expect(notes.split("\n\n")[0]).toBe("Line one line two line three");
  });

  it("trims a long excerpt at a sentence where it can", () => {
    const notes = composeInboxNotes({
      ...base,
      summary: null,
      content: `${"a".repeat(150)}. ${"b".repeat(400)}`,
    });
    const body = notes.split("\n\n")[0];
    expect(body.length).toBeLessThanOrEqual(302);
    expect(body.endsWith(".…")).toBe(true);
  });

  it("caps a rambling summary", () => {
    const notes = composeInboxNotes({ ...base, summary: "x".repeat(900) });
    expect(notes.split("\n\n")[0].length).toBe(400);
  });

  it("names texts and manual captures for what they are", () => {
    expect(composeInboxNotes({ ...base, source: "sms", summary: "s" })).toContain("· text ·");
    expect(composeInboxNotes({ ...base, source: "quick", summary: "s" })).toContain("· quick ·");
  });

  it("copes with a missing sender and an unparseable date", () => {
    const notes = composeInboxNotes({
      ...base,
      summary: "s",
      fromLabel: "  ",
      receivedAt: "not a date",
    });
    expect(notes).toContain("From an unknown sender");
    expect(notes.trimEnd().endsWith("email")).toBe(true);
  });
});
