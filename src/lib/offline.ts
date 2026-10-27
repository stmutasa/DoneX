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
 * The queue is shared by every tab and every sign-in on the device, so:
 * - each op records the role that queued it and replays only under a session
 *   of that role (the cookie decides whose change a replay becomes);
 * - storage is the source of truth: every change re-reads it first, and a
 *   cross-tab lock lets only one tab replay at a time.
 *
 * Scope: tasks only (create / complete / update / delete) — the core loop.
 * Everything else degrades to read-only offline, by design.
 */
import type { SessionRole, Task, TaskDraft } from "@/lib/types";
import { addDaysToDateKey, isoFromLocal, localDateKey } from "@/lib/utils";

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
  /** role of the session that queued it; missing on ops queued before roles were kept */
  role?: SessionRole;
  /** queued before this device knew who was signed in; the next live sign-in adopts it */
  roleUnknown?: true;
}

const QUEUE_KEY = "donex.outbox.v1";
const MAP_KEY = "donex.outbox.map.v1";
const ROLE_KEY = "donex.outbox.role.v1";
const LEASE_KEY = "donex.outbox.lease.v1";
const SYNC_LOCK = "donex-outbox-sync";
const OFFLINE_ID_PREFIX = "off_";

/** The service worker's cache of last-known reads and pages (public/sw.js). */
export const DATA_CACHE = "donex-data-v1";
/** Set by the service worker on a response it answered from DATA_CACHE. */
export const FROM_CACHE_HEADER = "x-donex-cache";

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

/** False when storage refused the write. */
function writeJson(key: string, value: unknown): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; /* quota — the op simply won't survive a reload */
  }
}

function removeKeys(...keys: string[]): void {
  const s = storage();
  if (!s) return;
  for (const key of keys) {
    try {
      s.removeItem(key);
    } catch {
      /* nothing to clear */
    }
  }
}

// ── Queue state + subscriptions ────────────────────────────────────────────

let queue: OutboxOp[] = readJson<OutboxOp[]>(QUEUE_KEY, []);
let syncing = false;
// Storage refused a write (quota, private mode), so this tab's copy is the
// truth from here on.
let memoryOnly = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

/** Re-read the queue: another tab may have changed it since. */
function loadQueue(): OutboxOp[] {
  if (!memoryOnly && storage()) queue = readJson<OutboxOp[]>(QUEUE_KEY, []);
  return queue;
}

/** Change the queue as it is stored now, never as this tab last saw it. */
function updateQueue(change: (ops: OutboxOp[]) => OutboxOp[]): void {
  queue = change(loadQueue());
  if (!writeJson(QUEUE_KEY, queue) && storage()) memoryOnly = true;
  notify();
}

function removeOp(id: string): void {
  updateQueue((ops) => ops.filter((o) => o.id !== id));
}

export function subscribeOutbox(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ── Session role ───────────────────────────────────────────────────────────
// `confirmedRole` comes from a live answer in this tab (/api/auth/me or a
// login). `knownRole` is the last role seen on this device (or in a cached
// /api/auth/me), so ops queued offline are tagged even after a cold start.

function readRole(): SessionRole | null {
  const role = readJson<unknown>(ROLE_KEY, null);
  return role === "owner" || role === "partner" ? role : null;
}

let confirmedRole: SessionRole | null = null;
let knownRole: SessionRole | null = readRole();

/** A personal create can only be the owner's: a partner's always go to the shared list. */
function pinnedRole(op: OutboxOp): SessionRole | null {
  return op.kind === "task-create" && op.synth?.space !== "joint" ? "owner" : null;
}

/** Who an op belongs to, or null while nobody has adopted it yet. */
function roleOf(op: OutboxOp): SessionRole | null {
  return op.role ?? pinnedRole(op);
}

function activeRole(): SessionRole | null {
  return confirmedRole ?? knownRole;
}

/** The ops that belong to whoever is signed in here (all of them until that is known). */
function ownOps(ops: OutboxOp[]): OutboxOp[] {
  const role = activeRole();
  if (!role) return ops;
  return ops.filter((op) => {
    const owner = roleOf(op);
    return owner === null || owner === role;
  });
}

/**
 * Give ops queued without a role (before roles were kept, or while this
 * device didn't know who was signed in) to the first live sign-in, which is
 * almost always the person who queued them. Personal creates stay the
 * owner's, and so does any later op on a task one of them created.
 */
function adoptUntagged(role: SessionRole): void {
  if (!loadQueue().some((op) => !op.role)) return;
  updateQueue((ops) => {
    const ownerIds: string[] = [];
    return ops.map((op) => {
      if (op.role) return op;
      const touchesOwners = ownerIds.some(
        (id) => op.url.includes(id) || (op.body?.includes(id) ?? false),
      );
      const adopted: OutboxOp = { ...op, role: pinnedRole(op) ?? (touchesOwners ? "owner" : role) };
      delete adopted.roleUnknown;
      if (adopted.role === "owner" && adopted.offlineId) ownerIds.push(adopted.offlineId);
      return adopted;
    });
  });
}

/**
 * Record the role a live server answer says this session has. Resolves once
 * any purge it starts is done, so a caller about to navigate can wait for it.
 */
export function noteSessionRole(role: SessionRole): Promise<void> {
  const previous = knownRole;
  confirmedRole = role;
  let purge: Promise<void> = Promise.resolve();
  if (role !== previous) {
    knownRole = role;
    writeJson(ROLE_KEY, role);
    // Someone else is signed in on this device now, and no sign-out cleared
    // up after the last person (an expired session, say). Their cached reads
    // go; their queued ops stay for their next sign-in.
    if (previous) purge = clearCachedReads();
  }
  adoptUntagged(role);
  notify();
  return purge;
}

/**
 * A cached /api/auth/me (served offline) is the last live answer this device
 * had: good enough to tag ops queued now, never to replay or purge on.
 */
export function noteCachedSessionRole(role: SessionRole): void {
  if (knownRole !== null) return;
  knownRole = role;
  writeJson(ROLE_KEY, role);
  notify();
}

// The app's time zone (settings.tz, from /api/auth/me), so the overlay splits
// Today from Upcoming where the server does.
let appZone: string | null = null;

export function noteAppZone(tz: string): void {
  appZone = tz || null;
}

/** The session is gone (a 401, a sign-out): wait for a live answer again. */
export function forgetSessionRole(): void {
  if (confirmedRole === null) return;
  confirmedRole = null;
  notify();
}

/** The role confirmed in this tab, or null while it isn't known yet. */
export function outboxSessionRole(): SessionRole | null {
  return confirmedRole;
}

// Other tabs' writes arrive as storage events; keep this tab's copy current.
function onStorage(e: StorageEvent): void {
  if (e.key !== null && e.key !== QUEUE_KEY && e.key !== ROLE_KEY) return;
  // Only clearLocalDataOnSignOut removes these: another tab signed out, so a
  // replay running here stops too.
  if (e.key === null || e.newValue === null) clearEpoch += 1;
  if (!memoryOnly) queue = readJson<OutboxOp[]>(QUEUE_KEY, []);
  knownRole = readRole();
  // Another tab saw a different sign-in, or a sign-out: this tab's answer is
  // stale until it asks again.
  if (confirmedRole !== null && confirmedRole !== knownRole) confirmedRole = null;
  notify();
}

if (typeof window !== "undefined") window.addEventListener("storage", onStorage);

export function outboxCount(): number {
  return ownOps(queue).length;
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
export function synthesizeTask(
  body: Record<string, unknown>,
  offlineId: string,
  createdBy: SessionRole = "owner",
): Task {
  const now = new Date().toISOString();
  const quick = typeof body.quick === "string" ? body.quick.trim() : null;
  // A quick create is parsed on the server, which ignores body.projectId, so
  // the synthesized task doesn't carry it either.
  const draft = (quick ? { title: quick } : body) as unknown as Partial<TaskDraft>;
  return {
    id: offlineId,
    title: (draft.title ?? "").toString().trim() || "New task",
    notes: draft.notes ?? "",
    status: "open",
    space: (body.space === "joint" ? "joint" : "personal") as Task["space"],
    createdBy,
    assignedTo:
      body.assignedTo === "owner" || body.assignedTo === "partner" ? body.assignedTo : null,
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

function parseBody<T>(body: string | null): T | null {
  if (!body) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/** An offline-created task as the queued ops so far leave it, or null for any other id. */
function offlineSnapshot(id: string): Task | null {
  let task: Task | null = null;
  for (const op of loadQueue()) {
    if (op.kind === "task-create") {
      if (op.offlineId === id && op.synth) task = { ...op.synth };
      continue;
    }
    if (!task || op.url.split("/")[3] !== id) continue;
    if (op.kind === "task-update") {
      task = { ...task, ...parseBody<Partial<Task>>(op.body), id };
    } else if (op.kind === "task-complete") {
      const done = parseBody<{ done?: boolean }>(op.body)?.done !== false;
      task = { ...task, status: done ? "done" : "open", completedAt: done ? op.queuedAt : null };
    } else {
      task = null;
    }
  }
  return task;
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

  const role = activeRole();
  const op: OutboxOp = {
    id: crypto.randomUUID(),
    kind,
    method: method as OutboxOp["method"],
    url,
    body: body ?? null,
    queuedAt: new Date().toISOString(),
  };
  if (role) op.role = role;
  else op.roleUnknown = true;

  let response: unknown;
  if (kind === "task-create") {
    const offlineId = newOfflineId();
    op.offlineId = offlineId;
    // Quick-adds re-parse on the server at sync time; anchor relative dates
    // ("tomorrow") to when the words were typed, not when the sync happens.
    if (typeof parsed.quick === "string") {
      op.body = JSON.stringify({ ...parsed, capturedAt: op.queuedAt });
    }
    op.synth = synthesizeTask(parsed, offlineId, role ?? "owner");
    response = { task: op.synth };
  } else if (kind === "task-complete") {
    const id = url.split("/")[3];
    response = { task: { id } as Task, recurred: false, changed: true };
  } else if (kind === "task-update") {
    const id = url.split("/")[3];
    // A task created offline is known in full here, so hand all of it back
    // rather than just the patch.
    response = { task: { ...(offlineSnapshot(id) ?? {}), ...parsed, id } as unknown as Task };
  } else {
    response = { ok: true };
  }

  updateQueue((ops) => [...ops, op]);
  return response;
}

// ── Overlay: replay the queue on top of (possibly stale) reads ─────────────

function startOfTomorrowIso(): string {
  if (appZone) {
    try {
      const tomorrow = addDaysToDateKey(localDateKey(new Date(), appZone), 1);
      return isoFromLocal(tomorrow, "00:00", appZone);
    } catch {
      /* unknown zone: the device's midnight below */
    }
  }
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}

/** tasksRepo.list's view clauses. A live deadline ("by") shows in Today and,
 *  when it is after today, in Upcoming too. */
function belongsInView(task: Task, view: string | null): boolean {
  if (view === "anytime") return task.dueAt === null;
  if (view === "today")
    return task.dueAt !== null && (task.dueAt < startOfTomorrowIso() || task.dueKind === "by");
  if (view === "upcoming") return task.dueAt !== null && task.dueAt >= startOfTomorrowIso();
  return true; // "all" or unfiltered
}

/** The filters a /api/tasks list key asks for (see keys.tasks in api.ts). */
interface ListScope {
  view: string | null;
  space: Task["space"];
  projectId: string | null;
  excludeProjects: boolean;
  tag: string | null;
  q: string | null;
  includeDone: boolean;
}

function listScope(key: string): ListScope {
  const params = new URLSearchParams(key.split("?")[1] ?? "");
  return {
    view: params.get("view"),
    space: params.get("space") === "joint" ? "joint" : "personal",
    projectId: params.get("projectId") || null,
    excludeProjects: params.get("excludeProjects") === "1",
    tag: params.get("tag") || null,
    q: params.get("q") || null,
    includeDone: params.get("includeDone") === "1",
  };
}

/** tasksRepo.list's filters, each with the task fields it reads. */
const LIST_PREDICATES: { fields: string[]; test: (t: Task, s: ListScope) => boolean }[] = [
  { fields: ["parentId"], test: (t) => t.parentId === null },
  { fields: ["space"], test: (t, s) => t.space === s.space },
  {
    fields: ["status", "dueAt", "dueKind"],
    test: (t, s) =>
      t.status === "done"
        ? // Done tasks show only with includeDone, and never in Upcoming or Anytime.
          s.includeDone && (s.view === null || s.view === "all" || s.view === "today")
        : belongsInView(t, s.view),
  },
  {
    fields: ["projectId"],
    test: (t, s) =>
      s.projectId ? t.projectId === s.projectId : !(s.excludeProjects && t.projectId !== null),
  },
  {
    fields: ["tags"],
    test: (t, s) => !s.tag || t.tags.some((tag) => tag.toLowerCase() === s.tag!.toLowerCase()),
  },
  {
    fields: ["title", "notes"],
    test: (t, s) => {
      if (!s.q) return true;
      const q = s.q.toLowerCase();
      return t.title.toLowerCase().includes(q) || t.notes.toLowerCase().includes(q);
    },
  },
];

/**
 * Whether a task belongs in the list. With `touched`, only the filters that
 * read those fields are checked: a task the server put in the list stays
 * there unless a queued change moved it out.
 */
function matchesList(task: Task, scope: ListScope, touched?: Set<string>): boolean {
  return LIST_PREDICATES.every(
    (p) => (touched && !p.fields.some((f) => touched.has(f))) || p.test(task, scope),
  );
}

export function applyOps<T>(key: string, data: T, ops: OutboxOp[]): T {
  if (!key.startsWith("/api/tasks") || key.includes("/api/tasks/")) return data;
  const record = data as { tasks?: Task[] } | null | undefined;
  if (!record || !Array.isArray(record.tasks)) return data;

  const scope = listScope(key);
  let tasks = record.tasks.slice();
  // Offline-created tasks as the ops so far leave them, so a later edit can
  // bring one into a list its first version didn't belong in.
  const created = new Map<string, Task>();

  const change = (id: string, patch: Partial<Task>) => {
    const listed = tasks.find((t) => t.id === id);
    const base = listed ?? created.get(id);
    if (!base) return;
    const next = { ...base, ...patch, id: base.id } as Task;
    if (created.has(id)) created.set(id, next);
    if (listed) {
      tasks = matchesList(next, scope, new Set(Object.keys(patch)))
        ? tasks.map((t) => (t.id === id ? next : t))
        : tasks.filter((t) => t.id !== id);
    } else if (matchesList(next, scope)) {
      tasks = [next, ...tasks];
    }
  };

  for (const op of ops) {
    const id = op.url.split("/")[3];
    if (op.kind === "task-create" && op.synth) {
      const synth = op.synth;
      created.set(synth.id, synth);
      if (!tasks.some((t) => t.id === synth.id) && matchesList(synth, scope)) {
        tasks = [synth, ...tasks];
      }
    } else if (op.kind === "task-complete") {
      const done = parseBody<{ done?: boolean }>(op.body)?.done !== false;
      change(id, { status: done ? "done" : "open", completedAt: done ? op.queuedAt : null });
    } else if (op.kind === "task-update") {
      change(id, parseBody<Partial<Task>>(op.body) ?? {});
    } else if (op.kind === "task-delete") {
      created.delete(id);
      tasks = tasks.filter((t) => t.id !== id);
    }
  }

  return { ...record, tasks } as T;
}

export function applyOutboxOverlay<T>(key: string, data: T): T {
  const ops = ownOps(queue);
  if (ops.length === 0) return data;
  return applyOps(key, data, ops);
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

/**
 * Statuses that say nothing about the change itself, so it is kept for a
 * later try: server trouble, a timeout, rate limiting, or a session that has
 * gone (it waits for the next sign-in as the same role).
 */
function isRetryable(status: number): boolean {
  return status >= 500 || status === 401 || status === 408 || status === 429;
}

const TAB_ID = Math.random().toString(36).slice(2);
const LEASE_MS = 30_000;

interface Lease {
  tab: string;
  until: number;
}

/**
 * Fallback for browsers without Web Locks: a short lease in localStorage.
 * Two tabs can write one at the same moment, so each waits a beat and only
 * the tab whose write stuck goes ahead.
 */
async function takeLease(): Promise<boolean> {
  if (!storage()) return true;
  const held = readJson<Lease | null>(LEASE_KEY, null);
  if (held && held.tab !== TAB_ID && held.until > Date.now()) return false;
  if (!writeJson(LEASE_KEY, { tab: TAB_ID, until: Date.now() + LEASE_MS })) return true;
  await new Promise((resolve) => setTimeout(resolve, 50));
  return readJson<Lease | null>(LEASE_KEY, null)?.tab === TAB_ID;
}

function renewLease(): void {
  if (readJson<Lease | null>(LEASE_KEY, null)?.tab === TAB_ID) {
    writeJson(LEASE_KEY, { tab: TAB_ID, until: Date.now() + LEASE_MS });
  }
}

function releaseLease(): void {
  if (readJson<Lease | null>(LEASE_KEY, null)?.tab === TAB_ID) removeKeys(LEASE_KEY);
}

/** Run `work` in at most one tab at a time; a tab that finds it taken gets `busy`. */
async function exclusively(
  work: (renew: () => void) => Promise<SyncResult>,
  busy: SyncResult,
): Promise<SyncResult> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks) {
    return await locks.request(SYNC_LOCK, { ifAvailable: true }, async (lock) =>
      lock ? work(() => undefined) : busy,
    );
  }
  if (!(await takeLease())) return busy;
  try {
    return await work(renewLease);
  } finally {
    releaseLease();
  }
}

// Bumped by clearLocalDataOnSignOut: a replay still running then (one that
// outlived the sign-out flush) stops, and writes nothing back.
let clearEpoch = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Whether a sign-out cleared the queue while this replay waited on the
 * server: in this tab (the epoch moved), or in another (the op has gone from
 * storage, and only a clear removes an op the lock holder is sending).
 */
function clearedUnder(epoch: number, opId: string): boolean {
  return epoch !== clearEpoch || !loadQueue().some((o) => o.id === opId);
}

/** Whose session the cookie is right now, asked of the server and never of a cache. */
async function liveSessionRole(): Promise<SessionRole | null> {
  try {
    const res = await fetch("/api/auth/me", {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401) forgetSessionRole();
    if (!res.ok || res.headers.get(FROM_CACHE_HEADER)) return null;
    const data = (await res.json()) as { role?: unknown };
    return data.role === "owner" || data.role === "partner" ? data.role : null;
  } catch {
    return null;
  }
}

/**
 * Whether any op could replay under the role confirmed in this tab (any op
 * at all while none is: the last-known role is a hint, maybe the last person's).
 */
function anyReplayable(ops: OutboxOp[]): boolean {
  return ops.some((op) => {
    const owner = roleOf(op);
    return !confirmedRole || owner === null || owner === confirmedRole;
  });
}

async function replay(renew: () => void): Promise<SyncResult> {
  const epoch = clearEpoch;
  let synced = 0;
  let dropped = 0;
  // Signed out, or the server can't be asked: everything waits.
  const role = await liveSessionRole();
  if (role && epoch === clearEpoch) {
    void noteSessionRole(role);
    const map = readJson<Record<string, string>>(MAP_KEY, {});
    const seen = new Set<string>();
    while (epoch === clearEpoch) {
      renew();
      // Oldest first, and only this session's: another role's ops wait for it.
      const queued = loadQueue();
      const next = queued.find((o) => roleOf(o) === role && !seen.has(o.id));
      if (!next) break;
      seen.add(next.id);

      let op = rewriteIds(next, map);
      if (op.kind !== "task-create" && op.url.includes(OFFLINE_ID_PREFIX)) {
        // Its create is still queued (another role's, waiting for them): it
        // waits too. A create that was dropped means it can never succeed.
        const waiting = queued.some(
          (o) => o.kind === "task-create" && !!o.offlineId && op.url.includes(o.offlineId),
        );
        if (!waiting) {
          removeOp(next.id);
          dropped += 1;
        }
        continue;
      }
      // A tick on a task created offline was checked against the synthesized
      // due, which the server's own parse need not share; don't let that
      // mismatch skip the tick.
      const tick = op.kind === "task-complete" ? parseBody<Record<string, unknown>>(op.body) : null;
      if (tick && "expectedDueAt" in tick && next.url.includes(OFFLINE_ID_PREFIX)) {
        delete tick.expectedDueAt;
        op = { ...op, body: JSON.stringify(tick) };
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
        let serverId: string | undefined;
        if (op.kind === "task-create" && op.offlineId) {
          try {
            serverId = ((await res.json()) as { task?: { id?: string } }).task?.id;
          } catch {
            /* create landed; references just won't remap */
          }
        }
        if (clearedUnder(epoch, next.id)) break;
        if (serverId && op.offlineId) {
          map[op.offlineId] = serverId;
          // Merge: entries written since this replay read the map stay.
          writeJson(MAP_KEY, {
            ...readJson<Record<string, string>>(MAP_KEY, {}),
            [op.offlineId]: serverId,
          });
        }
        removeOp(next.id);
        synced += 1;
      } else if (isRetryable(res.status)) {
        if (res.status === 401) forgetSessionRole();
        break; // keep the op, retry later
      } else {
        if (clearedUnder(epoch, next.id)) break;
        // The server has rejected it definitively (deleted elsewhere,
        // validation). Keeping it would poison the queue forever.
        removeOp(next.id);
        dropped += 1;
      }
    }
  }
  return { synced, dropped, remaining: ownOps(queue).length };
}

export async function syncOutbox(): Promise<SyncResult> {
  const idle = (): SyncResult => ({ synced: 0, dropped: 0, remaining: ownOps(queue).length });
  if (syncing) return idle();
  if (typeof navigator !== "undefined" && navigator.onLine === false) return idle();
  // Nothing to replay: no need to ask the server anything.
  if (!anyReplayable(loadQueue())) return idle();

  syncing = true;
  notify();
  try {
    return await exclusively(replay, idle());
  } finally {
    syncing = false;
    notify();
  }
}

// ── Sign-out ───────────────────────────────────────────────────────────────

const SIGN_OUT_FLUSH_MS = 3_000;

/** Like exclusively(), but waits behind a replay already running in another tab. */
async function inTurn(deadline: number): Promise<void> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks) {
    await locks.request(
      SYNC_LOCK,
      { signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) },
      () => replay(() => undefined),
    );
    return;
  }
  // Never start once the flush has given up: by then the sign-out has moved on.
  while (Date.now() < deadline) {
    if (await takeLease()) {
      try {
        if (Date.now() < deadline) await replay(renewLease);
      } finally {
        releaseLease();
      }
      return;
    }
    await sleep(Math.min(100, deadline - Date.now()));
  }
}

/**
 * Land what the queue can before a sign-out, while the session is still
 * live: waits (up to `maxMs` in all) for a replay already running in this
 * tab or another, then replays once more. Resolves with how many of the
 * signed-in role's ops are still queued, the ones clearLocalDataOnSignOut
 * would drop. Never throws.
 */
export async function flushOutboxBeforeSignOut(maxMs = SIGN_OUT_FLUSH_MS): Promise<number> {
  const left = () => ownOps(loadQueue()).length;
  try {
    if (!anyReplayable(loadQueue())) return left();
    if (typeof navigator !== "undefined" && navigator.onLine === false) return left();
    const deadline = Date.now() + maxMs;
    // This tab's own replay may be running: let it finish first.
    while (syncing && Date.now() < deadline) await sleep(25);
    if (syncing) return left();
    syncing = true;
    notify();
    // `syncing` stays set until the replay really ends, even past the deadline.
    const done = inTurn(deadline)
      .catch(() => undefined)
      .finally(() => {
        syncing = false;
        notify();
      });
    await Promise.race([done, sleep(deadline - Date.now())]);
  } catch {
    /* report what is left */
  }
  return left();
}

/** DATA_CACHE entries that hold nothing personal: content-hashed bundles and icons. */
function isSharedAsset(url: string): boolean {
  const path = new URL(url, "http://localhost").pathname;
  return path.startsWith("/_next/static") || path.startsWith("/icons");
}

function askWorker(worker: ServiceWorker, message: unknown, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(resolve, timeoutMs);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve();
    };
    worker.postMessage(message, [channel.port2]);
  });
}

/** Drop every cached read and page, so the next person on this device sees none of them. */
async function clearCachedReads(): Promise<void> {
  try {
    const worker =
      typeof navigator !== "undefined" && "serviceWorker" in navigator
        ? navigator.serviceWorker.controller
        : null;
    // The worker also stops a fetch already under way from caching its answer afterwards.
    if (worker) await askWorker(worker, { type: "CLEAR_DATA" });
  } catch {
    /* the purge below still runs */
  }
  try {
    if (typeof caches === "undefined" || !(await caches.has(DATA_CACHE))) return;
    const cache = await caches.open(DATA_CACHE);
    const entries = await cache.keys();
    await Promise.all(entries.filter((r) => !isSharedAsset(r.url)).map((r) => cache.delete(r)));
  } catch {
    /* best effort */
  }
}

/**
 * Forget everything this device holds for the signed-in person: their queued
 * ops and the service worker's cached API responses. Called on sign-out,
 * after flushOutboxBeforeSignOut and a logout the server confirmed. Another
 * role's queued ops stay for their next sign-in, with the id map entries
 * they still need.
 */
export async function clearLocalDataOnSignOut(): Promise<void> {
  clearEpoch += 1; // a replay still running stops and writes nothing back
  const role = activeRole();
  const kept = role
    ? loadQueue().filter((op) => {
        const owner = roleOf(op);
        return owner !== null && owner !== role;
      })
    : [];
  const refersTo = (offlineId: string) =>
    kept.some((op) => op.url.includes(offlineId) || (op.body?.includes(offlineId) ?? false));
  const map = Object.fromEntries(
    Object.entries(readJson<Record<string, string>>(MAP_KEY, {})).filter(([offlineId]) =>
      refersTo(offlineId),
    ),
  );

  queue = kept;
  memoryOnly = false;
  confirmedRole = null;
  knownRole = null;
  removeKeys(ROLE_KEY);
  if (kept.length) writeJson(QUEUE_KEY, kept);
  else removeKeys(QUEUE_KEY);
  if (Object.keys(map).length) writeJson(MAP_KEY, map);
  else removeKeys(MAP_KEY);
  notify();
  await clearCachedReads();
}

// Test seam: swap the queue (and its stored copy, when there is storage).
export function __setQueueForTests(ops: OutboxOp[]): void {
  queue = ops;
  writeJson(QUEUE_KEY, ops);
}
