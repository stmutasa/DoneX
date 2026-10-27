import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({
  requireOwner: async () => null,
  requireSession: async () => null,
  sessionRole: async () => "owner",
}));

// A throwaway data directory per run, so the real one is never touched.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "donex-resolve-"));
process.env.DATA_DIR = DIR;

const { feedbackRepo, inboxRepo, notesRepo, tasksRepo } = await import("@/lib/db/repos");
const { POST } = await import("@/app/api/inbox/[id]/resolve/route");

afterAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

async function resolve(id: string, body: unknown) {
  const req = new Request(`http://local/api/inbox/${id}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
  const res = await POST(req, { params: Promise.resolve({ id }) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const newItem = (content: string) => inboxRepo.create({ source: "gmail", content, fromLabel: "Shop" })!;

describe("POST /api/inbox/[id]/resolve", () => {
  it("makes a task from an item triage dismissed, since that made nothing", async () => {
    const item = newItem("Your invoice is ready");
    inboxRepo.resolve(item.id, "dismissed");
    const out = await resolve(item.id, { action: "task", task: { title: "Pay invoice" } });
    expect(out.status).toBe(200);
    expect(tasksRepo.get(out.json.taskId as string)?.title).toBe("Pay invoice");
    expect(inboxRepo.get(item.id)?.status).toBe("resolved");
  });

  it("makes a note from a dismissed item too", async () => {
    const item = newItem("Gate code is 4412");
    inboxRepo.resolve(item.id, "dismissed");
    const out = await resolve(item.id, { action: "note", note: { title: "Codes", content: "Gate 4412" } });
    expect(out.status).toBe(200);
    expect(notesRepo.findByTitle("Codes")?.content).toBe("Gate 4412");
    expect(inboxRepo.get(item.id)?.status).toBe("resolved");
  });

  it("refuses to make a second task or note from a resolved item", async () => {
    const item = newItem("Call the plumber");
    const first = await resolve(item.id, { action: "task", task: { title: "Call the plumber" } });
    expect(first.status).toBe(200);
    const before = tasksRepo.list({}).length;
    expect((await resolve(item.id, { action: "task" })).status).toBe(409);
    expect((await resolve(item.id, { action: "note" })).status).toBe(409);
    expect((await resolve(item.id, { action: "dismiss" })).status).toBe(409);
    expect(tasksRepo.list({}).length).toBe(before);
  });

  it("keeps the reason when an already-dismissed item is dismissed again", async () => {
    const item = newItem("Weekly deals");
    inboxRepo.resolve(item.id, "dismissed");
    const out = await resolve(item.id, { action: "dismiss", reason: "I never read deals" });
    expect(out).toEqual({ status: 200, json: { ok: true, learned: true } });
    expect(feedbackRepo.list().some((f) => f.reason === "I never read deals")).toBe(true);
    expect(inboxRepo.get(item.id)?.status).toBe("dismissed");
  });

  it("keeps a picked place on the task", async () => {
    const item = newItem("Pick up prescription");
    const location = { name: "CVS", address: "123 Main St", lat: 40.7, lng: -74 };
    const out = await resolve(item.id, { action: "task", task: { title: "Pick up prescription", location } });
    expect(tasksRepo.get(out.json.taskId as string)?.location).toEqual(location);
  });
});
