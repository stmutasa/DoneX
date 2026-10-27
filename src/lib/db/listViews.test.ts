import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";

// A throwaway data directory per run, so the real one is never touched.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "donex-lists-"));
process.env.DATA_DIR = DIR;

const { inboxRepo, notesRepo, projectsRepo } = await import("@/lib/db/repos");

afterAll(() => {
  fs.rmSync(DIR, { recursive: true, force: true });
});

const at = (minutesAgo: number) => new Date(Date.UTC(2026, 9, 26, 12, 0) - minutesAgo * 60_000).toISOString();

describe("inboxRepo.list({ status: 'all' })", () => {
  it("keeps every waiting item, however much newer history there is", () => {
    const waiting = inboxRepo.create({ source: "sms", content: "call the plumber", receivedAt: at(60 * 24 * 4) })!;
    for (let i = 0; i < 120; i++) {
      const item = inboxRepo.create({ source: "gmail", content: `newsletter ${i}`, receivedAt: at(i) })!;
      inboxRepo.resolve(item.id, "dismissed");
    }

    const all = inboxRepo.list({ status: "all" });
    expect(all.filter((i) => i.status === "new").map((i) => i.id)).toEqual([waiting.id]);
    expect(inboxRepo.newCount()).toBe(1);
    // History stays bounded.
    expect(all.filter((i) => i.status !== "new")).toHaveLength(100);
    // Newest first, with the old waiting item last.
    expect(all[0].content).toBe("newsletter 0");
    expect(all[all.length - 1].id).toBe(waiting.id);
  });
});

describe("archived notes and projects", () => {
  it("lists archived notes only when asked, search included", () => {
    const live = notesRepo.create({ title: "Groceries", kind: "note", content: "eggs" });
    const old = notesRepo.create({ title: "Wi-Fi passwords", kind: "note", content: "hunter2" });
    notesRepo.update(old.id, { archived: true });

    expect(notesRepo.list().map((n) => n.id)).toEqual([live.id]);
    expect(notesRepo.list({ archived: true }).map((n) => n.id)).toEqual([old.id]);
    expect(notesRepo.list({ q: "wi-fi", archived: true }).map((n) => n.id)).toEqual([old.id]);
    expect(notesRepo.list({ q: "wi-fi" })).toEqual([]);
  });

  it("lists archived projects only when asked", () => {
    const work = projectsRepo.create({ name: "Work" });
    const reno = projectsRepo.create({ name: "Kitchen reno" });
    projectsRepo.update(reno.id, { archived: true });

    expect(projectsRepo.list().map((p) => p.id)).toEqual([work.id]);
    const all = projectsRepo.list(true);
    expect(all.map((p) => p.id).sort()).toEqual([work.id, reno.id].sort());
    expect(all.find((p) => p.id === reno.id)?.archived).toBe(true);
  });

  it("finds an archived project by name instead of letting a duplicate be made", () => {
    const garden = projectsRepo.create({ name: "Garden" });
    projectsRepo.update(garden.id, { archived: true });

    // A lookup that must not change anything sees it, still archived.
    expect(projectsRepo.findByName("garden", { restore: false })).toMatchObject({
      id: garden.id,
      archived: true,
    });
    expect(projectsRepo.get(garden.id)?.archived).toBe(true);

    // Filing into it brings it back.
    expect(projectsRepo.findByName(" GARDEN ")).toMatchObject({ id: garden.id, archived: false });
    expect(projectsRepo.list().filter((p) => p.name === "Garden")).toHaveLength(1);
    expect(projectsRepo.findByName("No such project")).toBeNull();
  });

  it("matches names in any script, not only A-Z", () => {
    const ecole = projectsRepo.create({ name: "école" });
    expect(projectsRepo.findByName("École")?.id).toBe(ecole.id);
    expect(projectsRepo.findByName("e\u0301cole")?.id).toBe(ecole.id); // decomposed accent
    const shop = notesRepo.create({ title: "Épicerie", kind: "checklist" });
    expect(notesRepo.findByTitle("épicerie")?.id).toBe(shop.id);
    expect(notesRepo.findByTitle(" ÉPICERIE ")?.id).toBe(shop.id);
    notesRepo.update(shop.id, { archived: true });
    expect(notesRepo.findByTitle("épicerie")).toBeNull();
  });

  it("prefers the live project when an archived one shares its name", () => {
    const old = projectsRepo.create({ name: "Reading" });
    projectsRepo.update(old.id, { archived: true });
    const live = projectsRepo.create({ name: "Reading" });

    expect(projectsRepo.findByName("reading")?.id).toBe(live.id);
    expect(projectsRepo.get(old.id)?.archived).toBe(true);
  });
});
