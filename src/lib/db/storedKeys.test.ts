import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";

// A throwaway data directory per run, so the real one is never touched.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "donex-keys-"));
process.env.DATA_DIR = DIR;

const { getDb, dropStoredKeys } = await import("@/lib/db");
const { settingsRepo } = await import("@/lib/db/repos");

afterAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

describe("dropStoredKeys", () => {
  it("wipes keys an older version stored, and leaves everything else alone", () => {
    settingsRepo.updateApp({
      ai: { openaiKey: "sk-old", anthropicKey: "sk-ant-old", customKey: "ck-old", model: "picked" },
    } as never);
    dropStoredKeys(getDb());
    const ai = settingsRepo.getApp().ai;
    expect([ai.openaiKey, ai.anthropicKey, ai.customKey]).toEqual(["", "", ""]);
    expect(ai.model).toBe("picked");
  });

  it("writes nothing when there is nothing to wipe", () => {
    const before = getDb().prepare("SELECT value FROM settings WHERE key='app'").get();
    dropStoredKeys(getDb());
    expect(getDb().prepare("SELECT value FROM settings WHERE key='app'").get()).toEqual(before);
  });
});
