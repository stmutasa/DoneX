import { describe, expect, it } from "vitest";
import { parseIngestPayload } from "@/lib/ingest";

const none = new URLSearchParams();
const JSON_CT = "application/json";

describe("parseIngestPayload", () => {
  it("reads the documented JSON body", () => {
    const out = parseIngestPayload(
      '{"from":"Mom +15551234567","body":"Dinner at 7?"}',
      JSON_CT,
      none,
    );
    expect(out).toEqual({ from: "Mom +15551234567", body: "Dinner at 7?", receivedAt: undefined });
  });

  it("salvages a multi-line text that broke the JSON template", () => {
    // MacroDroid interpolates the raw message, so newlines land unescaped.
    const raw = '{"from":"CVS Pharmacy","body":"Your prescription is ready.\nPick up by Friday."}';
    const out = parseIngestPayload(raw, JSON_CT, none);
    expect(out.from).toBe("CVS Pharmacy");
    expect(out.body).toContain("prescription is ready");
    expect(out.body).toContain("Pick up by Friday");
  });

  it("salvages a message containing a double quote", () => {
    const raw = '{"from":"Sam","body":"He said "bring the ladder" tomorrow"}';
    const out = parseIngestPayload(raw, JSON_CT, none);
    expect(out.from).toBe("Sam");
    expect(out.body).toBe('He said "bring the ladder" tomorrow');
  });

  it("prefers query params, which the phone url-encodes safely", () => {
    const search = new URLSearchParams({ from: "Vet", body: 'Rex is due for "shots"\nnext week' });
    const out = parseIngestPayload("", "", search);
    expect(out.from).toBe("Vet");
    expect(out.body).toContain("Rex is due");
    expect(out.body).toContain("next week");
  });

  it("accepts a form-encoded body", () => {
    const out = parseIngestPayload(
      "from=School&body=Parent+evening+moved+to+Thursday",
      "application/x-www-form-urlencoded; charset=utf-8",
      none,
    );
    expect(out).toEqual({
      from: "School",
      body: "Parent evening moved to Thursday",
      receivedAt: undefined,
    });
  });

  it("falls back to treating plain text as the message", () => {
    const out = parseIngestPayload("Package delivered to the porch", "text/plain", none);
    expect(out).toEqual({ from: "SMS", body: "Package delivered to the porch" });
  });

  it("defaults a missing sender rather than dropping the message", () => {
    expect(parseIngestPayload('{"body":"No sender here"}', JSON_CT, none)).toMatchObject({
      from: "SMS",
      body: "No sender here",
    });
    expect(parseIngestPayload("", "", new URLSearchParams({ body: "Just a body" }))).toMatchObject({
      from: "SMS",
      body: "Just a body",
    });
  });

  it("returns nothing usable for an empty payload", () => {
    expect(parseIngestPayload("   ", JSON_CT, none)).toEqual({});
  });

  it("keeps an explicit receivedAt when supplied", () => {
    const out = parseIngestPayload(
      '{"from":"A","body":"B","receivedAt":"2026-08-17T12:00:00Z"}',
      JSON_CT,
      none,
    );
    expect(out.receivedAt).toBe("2026-08-17T12:00:00Z");
  });
});
