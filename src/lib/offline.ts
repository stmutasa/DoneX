/**
 * Offline outbox for task mutations.
 *
 * When a write fails because the network is gone, the request is queued here
 * and a synthesized success is returned so the UI carries on. Reads served
 * from the service-worker cache are passed through `applyOutboxOverlay`, which
 * replays the queue on top of them — so what you see offline includes what
 * you did offline. `syncOutbox` replays the queue against the real API once
 * the connection returns, mapping offline ids to server ids as creates land.
 *
 * Scope: tasks only (create / complete / update / delete) — the core loop.
 * Everything else degrades to read-only offline, by design.
 */
import type { Task, TaskDraft } from "@/lib/types";

export type OutboxKind = "task-create" | "task-complete" | "task-update" | "task-delete";

export interface OutboxOp {
  id: string;
  kind: OutboxKind;
  method: "POST" | "PATCH" | "DELETE";
  url: string;
  /** JSON body as originally sent (null for DELETE) */
  body: string | null;
  /** for creates: the client-generated id the UI is showing */
  offlineId?: string;
  /** for creates: the synthesized task, so the overlay can render it */
  synth?: Task;
  queuedAt: string;
}

const QUEUE_KEY = "donex.outbox.v1";
const MAP_KEY = "donex.outbox.map.v1";
const OFFLINE_ID_PREFIX = "off_";

// ── Storage (guarded so the module stays importable in tests/SSR) ──────────

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function readJson<T>(key: string, fallback: T): T {
  const s = storage();
  if (!s) return fallback;
  try {
    const raw = s.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(key, JSON.stringify(value));
  } catch {
    /* quota — the op simply won't survive a reload */
  }
}

// ── Queue state + subscriptions ────────────────────────────────────────────

let queue: OutboxOp[] = readJson<OutboxOp[]>(QUEUE_KEY, []);
let syncing = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

function persist(): void {
  writeJson(QUEUE_KEY, queue);
  notify();
}

export function subscribeOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function outboxCount(): number {
  return queue.length;
}

export function outboxSyncing(): boolean {
  return syncing;
}

export function newOfflineId(): string {
  return `${OFFLINE_ID_PREFIX}${crypto.randomUUID()}`;
}

export function isOfflineId(id: string): boolean {
  return id.startsWith(OFFLINE_ID_PREFIX);
}

// ── Classification: which failed writes can be queued? ─────────────────────

export function classifyRequest(method: string, url: string): OutboxKind | null {
  const path = url.split("?")[0];
  if (method === "POST" && path === "/api/tasks") return "task-create";
  const m = /^\/api\/tasks\/([^/]+)(\/complete)?$/.exec(path);
  if (!m) return null;
  if (method === "POST" && m[2]) return "task-complete";
  if (method === "PATCH" && !m[2]) return "task-update";
  if (method === "DELETE" && !m[2]) return "task-delete";
  return null;
}

/** Build the synthesized Task an offline create shows until it syncs. */
export function synthesizeTask(body: Record<string, unknown>, offlineId: string): Task {
  const now = new Date().toISOString();
  const quick = typeof body.quick === "string" ? body.quick.trim() : null;
  const draft = (quick ? { title: quick } : body) as unknown as Partial<TaskDraft>;
  return {
    id: offlineId,
    title: (draft.title ?? "").toString().trim() || "New task",
    notes: draft.notes ?? "",
    status: "open",
    space: (body.space === "joint" ? "joint" : "personal") as Task["space"],
    createdBy: "owner",
    priority: draft.priority ?? 0,
    dueAt: draft.dueAt ?? null,
    dueKind: draft.dueKind === "by" ? "by" : "on",
    allDay: draft.allDay ?? false,
    projectId: draft.projectId ?? null,
    tags: draft.tags ?? [],
    parentId: draft.parentId ?? null,
    recurrence: draft.recurrence ?? null,
    location: draft.location ?? null,
    sort: Date.now(),
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    subtasks: [],
  };
}

/**
 * Queue a failed write and hand back the payload the caller expected.
 * Returns null when the request isn't one we know how to queue.
 */
export function enqueueFailedRequest(
  method: string,
  url: string,
  body: string | undefined,
): unknown | null {
  const kind = classifyRequest(method, url);
  if (!kind) return null;

  let parsed: Record<string, unknown> = {};
  try {
    parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
  } catch {
    return null;
  }

  const op: OutboxOp = {
    id: crypto.randomUUID(),
    kind,
    method: method as OutboxOp["method"],
    url,
    body: body ?? null,
    queuedAt: new Date().toISOString(),
  };

  let response: unknown;
  if (kind === "task-create") {
    const offlineId = newOfflineId();
    op.offlineId = offlineId;
    // Quick-adds re-parse on the server at sync time; anchor relative dates
    // ("tomorrow") to when the words were typed, not when the sync happens.
    if (typeof parsed.quick === "string") {
      op.body = JSON.stringify({ ...parsed, capturedAt: op.queuedAt });
    }
    op.synth = synthesizeTask(parsed, offlineId);
    response = { task: op.synth };
  } else if (kind === "task-complete") {
    const id = url.split("/")[3];
    response = { task: { id } as Task, recurred: false };
  } else if (kind === "task-update") {
    const id = url.split("/")[3];
    response = { task: { id, ...parsed } as unknown as Task };
  } else {
    response = { ok: true };
  }

  queue = [...queue, op];
  persist();
  return response;
}

// ── Overlay: replay the queue on top of (possibly stale) reads ─────────────

function parseParam(key: string, name: string): string | null {
  const q = key.split("?")[1];
  if (!q) return null;
  return new URLSearchParams(q).get(name);
}

function startOfTomorrowIso(): string {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}

function belongsInView(task: Task, view: string | null): boolean {
  if (view === "anytime") return task.dueAt === null;
  if (view === "today")
    return task.dueAt !== null && (task.dueAt < startOfTomorrowIso() || task.dueKind === "by");
  if (view === "upcoming")
    return task.dueAt !== null && task.dueAt >= startOfTomorrowIso() && task.dueKind !== "by";
  return true; // "all" or unfiltered
}

export function applyOps<T>(key: string, data: T, ops: OutboxOp[]): T {
  if (!key.startsWith("/api/tasks") || key.includes("/api/tasks/")) return data;
  const record = data as { tasks?: Task[] } | null | undefined;
  if (!record || !Array.isArray(record.tasks)) return data;

  const view = parseParam(key, "view");
  const keySpace = parseParam(key, "space") === "joint" ? "joint" : "personal";
  let tasks = record.tasks.slice();

  for (const op of ops) {
    if (op.kind === "task-create" && op.synth) {
      const exists = tasks.some((t) => t.id === op.synth!.id);
      if (
        !exists &&
        op.synth.parentId === null &&
        op.synth.space === keySpace &&
        belongsInView(op.synth, view)
      ) {
        tasks = [op.synth, ...tasks];
      }
    } else if (op.kind === "task-complete") {
      const id = op.url.split("/")[3];
      let done = true;
      try {
        done = op.body ? (JSON.parse(op.body) as { done?: boolean }).done !== false : true;
      } catch {
        /* default true */
      }
      tasks = tasks.map((t) =>
        t.id === id
          ? {
              ...t,
              status: done ? "done" : "open",
              completedAt: done ? op.queuedAt : null,
            }
          : t,
      );
      if (done && !key.includes("includeDone")) tasks = tasks.filter((t) => t.id !== id);
    } else if (op.kind === "task-update") {
      const id = op.url.split("/")[3];
      let patch: Partial<Task> = {};
      try {
        patch = op.body ? (JSON.parse(op.body) as Partial<Task>) : {};
      } catch {
        /* skip */
      }
      tasks = tasks.map((t) => (t.id === id ? { ...t, ...patch, id: t.id } : t));
    } else if (op.kind === "task-delete") {
      const id = op.url.split("/")[3];
      tasks = tasks.filter((t) => t.id !== id);
    }
  }

  return { ...record, tasks } as T;
}

export function applyOutboxOverlay<T>(key: string, data: T): T {
  if (queue.length === 0) return data;
  return applyOps(key, data, queue);
}

// ── Sync: replay against the real API once we're back online ───────────────

/** Substitute freshly-minted server ids anywhere an offline id appears. */
export function rewriteIds(op: OutboxOp, map: Record<string, string>): OutboxOp {
  let { url, body } = op;
  for (const [offline, real] of Object.entries(map)) {
    url = url.split(offline).join(real);
    if (body) body = body.split(offline).join(real);
  }
  return { ...op, url, body };
}

export interface SyncResult {
  synced: number;
  dropped: number;
  remaining: number;
}

export async function syncOutbox(): Promise<SyncResult> {
  const idle: SyncResult = { synced: 0, dropped: 0, remaining: queue.length };
  if (syncing || queue.length === 0) return idle;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return idle;

  syncing = true;
  notify();
  const map = readJson<Record<string, string>>(MAP_KEY, {});
  let synced = 0;
  let dropped = 0;

  try {
    while (queue.length > 0) {
      const op = rewriteIds(queue[0], map);
      // An op still pointing at an offline id whose create was dropped can
      // never succeed server-side.
      if (op.kind !== "task-create" && op.url.includes(OFFLINE_ID_PREFIX)) {
        queue = queue.slice(1);
        dropped += 1;
        persist();
        continue;
      }

      let res: Response;
      try {
        res = await fetch(op.url, {
          method: op.method,
          credentials: "same-origin",
          headers: op.body ? { "content-type": "application/json" } : undefined,
          body: op.body ?? undefined,
        });
      } catch {
        break; // still offline — try again later
      }

      if (res.ok) {
        if (op.kind === "task-create" && op.offlineId) {
          try {
            const data = (await res.json()) as { task?: { id?: string } };
            if (data.task?.id) {
              map[op.offlineId] = data.task.id;
              writeJson(MAP_KEY, map);
            }
          } catch {
            /* create landed; references just won't remap */
          }
        }
        queue = queue.slice(1);
        synced += 1;
        persist();
      } else if (res.status >= 500) {
        break; // server trouble — keep the op, retry later
      } else {
        // 4xx: the server has rejected it definitively (deleted elsewhere,
        // validation). Keeping it would poison the queue forever.
        queue = queue.slice(1);
        dropped += 1;
        persist();
      }
    }
  } finally {
    syncing = false;
    notify();
  }

  return { synced, dropped, remaining: queue.length };
}

// Test seam: swap the queue without touching real storage.
export function __setQueueForTests(ops: OutboxOp[]): void {
  queue = ops;
}
