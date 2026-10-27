import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";

// places.ts reads settings through the repos; keep any database out of the real data dir.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "donex-places-"));
process.env.DATA_DIR = DIR;

const { explainPlacesError } = await import("@/lib/google/places");

afterAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

const googleError = (message: string, reason: string) =>
  JSON.stringify({
    error: {
      code: 403,
      message,
      status: "PERMISSION_DENIED",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com" }],
    },
  });

describe("explainPlacesError", () => {
  it("points a referrer-restricted key at its restrictions, not at enabling the API", () => {
    const body = googleError("Requests from referer <empty> are blocked.", "API_KEY_HTTP_REFERRER_BLOCKED");
    expect(explainPlacesError(403, body)).toMatch(/restrictions block this server/);
  });

  it("treats an IP-restricted key the same way", () => {
    const body = googleError(
      "The provided API key has an IP address restriction. The originating IP address of the call (1.2.3.4) violates this restriction.",
      "API_KEY_IP_ADDRESS_BLOCKED",
    );
    expect(explainPlacesError(403, body)).toMatch(/restrictions block this server/);
  });

  it("says when the key's API restrictions leave Places out", () => {
    const body = googleError(
      "Requests to this API places.googleapis.com method google.maps.places.v1.Places.SearchText are blocked.",
      "API_KEY_SERVICE_BLOCKED",
    );
    expect(explainPlacesError(403, body)).toMatch(/API restrictions leave out/);
  });

  it("still asks for the API to be enabled when it is off", () => {
    const body = googleError(
      "Places API (New) has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/places.googleapis.com/overview?project=123 then retry.",
      "SERVICE_DISABLED",
    );
    expect(explainPlacesError(403, body)).toMatch(/^Enable the/);
  });

  it("recognises a bad key", () => {
    const body = JSON.stringify({
      error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" },
    });
    expect(explainPlacesError(400, body)).toMatch(/rejected the Maps API key/);
  });

  it("falls back to the status code", () => {
    expect(explainPlacesError(500, "")).toBe("Place search failed (500)");
  });
});
