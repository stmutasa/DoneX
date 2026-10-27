import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A throwaway data directory per run, so the real one is never touched.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "donex-review-route-"));
process.env.DATA_DIR = DIR;

/** The model, faked: every call here would be a billed one. */
const fake = vi.hoisted(() => ({
  calls: [] as { weekKey: string; force?: boolean }[],
  fail: false,
  gate: null as Promise<void> | null,
}));

vi.mock("@/lib/auth", () => ({ requireOwner: async () => null }));

vi.mock("@/lib/ai", () => ({
  aiConfigured: () => true,
  generateWeeklyReview: async (weekKey: string, opts: { force?: boolean } = {}) => {
    fake.calls.push({ weekKey, force: opts.force });
    if (fake.gate) await fake.gate;
    if (fake.fail) throw new Error("The model did not return valid JSON.");
    const { completionsRepo, reviewsRepo } = await import("@/lib/db/repos");
    const review = {
      weekKey,
      completedCount: completionsRepo.countRange("2026-10-26", "2026-11-01"),
      createdCount: 0,
      streak: 0,
      bestDay: null,
      narrative: "Fresh.",
      suggestions: [],
      generatedAt: new Date().toISOString(),
    };
    reviewsRepo.save(review);
    return review;
  },
}));

const { getDb } = await import("@/lib/db");
const { reviewsRepo } = await import("@/lib/db/repos");
const { GET } = await import("@/app/api/assistant/review/route");

const WEEK = "2026-W44"; // Mon Oct 26 to Sun Nov 1
let completions = 0;

function complete(dateLocal: string): void {
  completions += 1;
  getDb()
    .prepare(
      "INSERT INTO completions(id, task_id, title, completed_at, date_local) VALUES(?,?,?,?,?)",
    )
    .run(`c${completions}`, `t${completions}`, "done", `${dateLocal}T15:00:00.000Z`, dateLocal);
}

/** What the Review page saved on Monday morning. */
function savedOnMonday(completedCount: number): void {
  reviewsRepo.save({
    weekKey: WEEK,
    completedCount,
    createdCount: 0,
    streak: 0,
    bestDay: null,
    narrative: "Saved on Monday.",
    suggestions: [],
    generatedAt: "2026-10-26T13:00:00.000Z",
  });
}

async function get(query = ""): Promise<{ status: number; narrative?: string }> {
  const res = await GET(new Request(`http://localhost/api/assistant/review${query}`));
  const body = (await res.json()) as { review?: { narrative: string } };
  return { status: res.status, narrative: body.review?.narrative };
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-28T15:00:00Z")); // Wed 11:00 AM EDT
});

afterAll(() => {
  vi.useRealTimers();
  fs.rmSync(DIR, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().prepare("DELETE FROM reviews").run();
  getDb().prepare("DELETE FROM completions").run();
  getDb().prepare("DELETE FROM settings WHERE key LIKE 'review.%'").run();
  fake.calls = [];
  fake.fail = false;
  fake.gate = null;
});

describe("GET /api/assistant/review", () => {
  it("serves a mid-week review as it is while nothing new has been completed", async () => {
    complete("2026-10-26");
    savedOnMonday(1);
    expect(await get()).toEqual({ status: 200, narrative: "Saved on Monday." });
    expect(fake.calls).toEqual([]);
  });

  it("writes it again once there is something new, and only once that day", async () => {
    complete("2026-10-26");
    savedOnMonday(1);
    complete("2026-10-28");
    expect((await get()).narrative).toBe("Fresh.");
    expect(fake.calls).toEqual([{ weekKey: WEEK, force: true }]);

    complete("2026-10-28");
    await get();
    await get();
    expect(fake.calls).toHaveLength(1);
  });

  it("shows the saved review when a rewrite fails, and doesn't try again that day", async () => {
    savedOnMonday(0);
    complete("2026-10-28");
    fake.fail = true;
    expect(await get()).toEqual({ status: 200, narrative: "Saved on Monday." });
    expect(await get()).toEqual({ status: 200, narrative: "Saved on Monday." });
    expect(fake.calls).toHaveLength(1);
  });

  it("doesn't set off a rewrite of its own after a failed Regenerate", async () => {
    savedOnMonday(0);
    complete("2026-10-28");
    fake.fail = true;
    expect((await get("?refresh=1")).status).toBe(502);
    // The page refetches after the failure.
    expect(await get()).toEqual({ status: 200, narrative: "Saved on Monday." });
    expect(fake.calls).toEqual([{ weekKey: WEEK, force: true }]);
  });

  it("shares one generation between requests that arrive together", async () => {
    let release = () => {};
    fake.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const both = Promise.all([get(), get()]);
    await Promise.resolve();
    release();
    expect((await both).map((r) => r.narrative)).toEqual(["Fresh.", "Fresh."]);
    expect(fake.calls).toHaveLength(1);
  });

  it("opens the week the push linked to, but never one still to come", async () => {
    await get("?week=2026-W43");
    await get("?week=2026-W52");
    await get("?week=nonsense");
    expect(fake.calls.map((c) => c.weekKey)).toEqual(["2026-W43", WEEK]);
  });
});
