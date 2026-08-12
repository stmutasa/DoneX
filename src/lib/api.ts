/**
 * Typed browser client for the DoneX API + SWR key builders.
 * Every failure surfaces as an ApiError carrying the server's {error} message.
 */
import type {
  AISettings,
  Briefing,
  CalendarEvent,
  ChatMessageRecord,
  ChatStreamEvent,
  Conversation,
  DayPlan,
  GoogleSettings,
  GoogleStatus,
  InboxItem,
  InboxStatus,
  LogbookDay,
  MaskedSettings,
  ModelInfo,
  NearbyTask,
  PlaceResult,
  Note,
  NotificationSettings,
  PlanBlock,
  Project,
  StatsSummary,
  Task,
  TaskDraft,
  TaskListFilter,
  TaskPatch,
  ToolActivity,
  TriageFeedback,
  VoiceSettings,
  WeeklyReview,
} from "@/lib/types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function query(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    sp.set(k, v === true ? "1" : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

const REQUEST_TIMEOUT_MS = 20_000;
/** For endpoints that do real work (Gmail scans, AI triage batches). */
const SLOW_TIMEOUT_MS = 150_000;

/** Combine a caller signal (if any) with a hard timeout, so a stalled mobile
 *  connection can never leave a request — and the UI waiting on it — hanging
 *  forever. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

type RequestInitEx = RequestInit & { timeoutMs?: number };

async function request<T>(url: string, init?: RequestInitEx): Promise<T> {
  const hasBody = init?.body !== undefined;
  const { timeoutMs, ...rest } = init ?? {};
  let res: Response;
  try {
    res = await fetch(url, {
      credentials: "same-origin",
      ...rest,
      signal: withTimeout(rest.signal ?? undefined, timeoutMs ?? REQUEST_TIMEOUT_MS),
      headers: {
        ...(hasBody ? { "content-type": "application/json" } : {}),
        ...(rest.headers ?? {}),
      },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new ApiError("Request timed out — check your connection and try again", 0);
    }
    throw err;
  }

  if (!res.ok) {
    let message = `Something went wrong (${res.status})`;
    try {
      const data: unknown = await res.json();
      if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") {
        message = (data as { error: string }).error;
      }
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401 && typeof window !== "undefined" && !url.startsWith("/api/auth/")) {
      const path = window.location.pathname;
      if (path !== "/login" && path !== "/setup") window.location.href = "/login";
    }
    throw new ApiError(message, res.status);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/** Generic SWR fetcher: `useSWR<{tasks: Task[]}>(keys.tasks(f), fetcher)` */
export const fetcher = <T,>(url: string): Promise<T> => request<T>(url);

// ── SWR keys ──────────────────────────────────────────────────────────────

export const keys = {
  tasks: (filter: TaskListFilter = {}) =>
    `/api/tasks${query({
      view: filter.view,
      projectId: filter.projectId,
      tag: filter.tag,
      q: filter.q,
      includeDone: filter.includeDone,
    })}`,
  tags: () => "/api/tags",
  projects: () => "/api/projects",
  notes: (q?: string) => `/api/notes${query({ q })}`,
  inbox: (status: InboxStatus | "all" | "new" = "new") => `/api/inbox${query({ status })}`,
  conversations: () => "/api/chat/conversations",
  history: (conversationId?: string | null) =>
    `/api/chat/history${query({ conversationId: conversationId ?? undefined })}`,
  briefing: (refresh?: boolean) => `/api/assistant/briefing${query({ refresh })}`,
  plan: () => "/api/assistant/plan",
  review: (refresh?: boolean) => `/api/assistant/review${query({ refresh })}`,
  stats: () => "/api/stats",
  settings: () => "/api/settings",
  models: (provider: AISettings["provider"]) => `/api/settings/models${query({ provider })}`,
  googleStatus: () => "/api/google/status",
  calendarToday: () => "/api/calendar/today",
  vapid: () => "/api/push/vapid",
} as const;

/** Matcher for `mutate(...)` bulk revalidation. */
export const matchKey =
  (...prefixes: string[]) =>
  (key: unknown): boolean =>
    typeof key === "string" && prefixes.some((p) => key.startsWith(p));

// ── Auth ──────────────────────────────────────────────────────────────────

export const authApi = {
  setup: (pin: string, tz: string) =>
    request<{ ok: true }>("/api/auth/setup", {
      method: "POST",
      body: JSON.stringify({ pin, tz }),
    }),
  login: (pin: string) =>
    request<{ ok: true }>("/api/auth/login", { method: "POST", body: JSON.stringify({ pin }) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  changePin: (pin: string) =>
    request<{ ok: true }>("/api/auth/change-pin", {
      method: "POST",
      body: JSON.stringify({ pin }),
    }),
};

// ── Tasks ─────────────────────────────────────────────────────────────────

export type TaskCreateInput = TaskDraft | { quick: string; projectId?: string | null };

export const tasksApi = {
  list: (filter: TaskListFilter = {}) => request<{ tasks: Task[] }>(keys.tasks(filter)),
  create: (input: TaskCreateInput) =>
    request<{ task: Task }>("/api/tasks", { method: "POST", body: JSON.stringify(input) }),
  update: (id: string, patch: TaskPatch) =>
    request<{ task: Task }>(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (id: string) => request<{ ok: true }>(`/api/tasks/${id}`, { method: "DELETE" }),
  complete: (id: string, done: boolean) =>
    request<{ task: Task; recurred: boolean }>(`/api/tasks/${id}/complete`, {
      method: "POST",
      body: JSON.stringify({ done }),
    }),
  reorder: (ids: string[]) =>
    request<{ ok: true }>("/api/tasks/reorder", { method: "POST", body: JSON.stringify({ ids }) }),
  tags: () => request<{ tags: string[] }>(keys.tags()),
};

// ── Projects ──────────────────────────────────────────────────────────────

export const projectsApi = {
  list: () => request<{ projects: Project[] }>(keys.projects()),
  create: (input: { name: string; color?: string; icon?: string }) =>
    request<{ project: Project }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  update: (id: string, patch: Partial<Pick<Project, "name" | "color" | "icon" | "archived" | "sort">>) =>
    request<{ project: Project }>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  remove: (id: string) => request<{ ok: true }>(`/api/projects/${id}`, { method: "DELETE" }),
};

// ── Notes ─────────────────────────────────────────────────────────────────

export const notesApi = {
  list: (q?: string) => request<{ notes: Note[] }>(keys.notes(q)),
  create: (input: Partial<Note>) =>
    request<{ note: Note }>("/api/notes", { method: "POST", body: JSON.stringify(input) }),
  update: (id: string, patch: Partial<Note>) =>
    request<{ note: Note }>(`/api/notes/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  remove: (id: string) => request<{ ok: true }>(`/api/notes/${id}`, { method: "DELETE" }),
};

// ── Inbox ─────────────────────────────────────────────────────────────────

export interface InboxResolvePayload {
  action: "task" | "note" | "dismiss";
  task?: TaskDraft;
  note?: { title: string; content: string };
  /** dismiss only — recorded as a triage lesson */
  reason?: string;
}

export const inboxApi = {
  list: (status: "new" | "all" = "new") =>
    request<{ items: InboxItem[]; newCount: number }>(keys.inbox(status)),
  capture: (content: string) =>
    request<{ item: InboxItem }>("/api/inbox", {
      method: "POST",
      body: JSON.stringify({ content, source: "quick" }),
    }),
  resolve: (id: string, payload: InboxResolvePayload) =>
    request<{ ok: true; taskId?: string; learned?: boolean }>(`/api/inbox/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  restore: (id: string, reason?: string) =>
    request<{ ok: true; learned: boolean }>(`/api/inbox/${id}/restore`, {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    }),
  lessons: () => request<{ lessons: TriageFeedback[] }>("/api/inbox/feedback"),
  removeLesson: (id: string) =>
    request<{ ok: true }>("/api/inbox/feedback", {
      method: "DELETE",
      body: JSON.stringify({ id }),
    }),
  triage: (id?: string) =>
    request<{ items: InboxItem[]; kept?: number; dismissed?: number; updated?: number }>(
      "/api/inbox/triage",
      {
        method: "POST",
        body: JSON.stringify(id ? { id } : {}),
        timeoutMs: SLOW_TIMEOUT_MS,
      },
    ),
};

// ── Assistant ─────────────────────────────────────────────────────────────

export const assistantApi = {
  briefing: (refresh = false) => request<{ briefing: Briefing }>(keys.briefing(refresh)),
  plan: (refresh = false) =>
    request<{ plan: DayPlan }>("/api/assistant/plan", {
      method: "POST",
      body: JSON.stringify({ refresh }),
    }),
  acceptPlan: (blocks: PlanBlock[], addToCalendar = false) =>
    request<{ plan: DayPlan }>("/api/assistant/plan/accept", {
      method: "POST",
      body: JSON.stringify({ blocks, addToCalendar }),
    }),
  review: (refresh = false) => request<{ review: WeeklyReview }>(keys.review(refresh)),
};

export const chatApi = {
  history: (conversationId?: string | null) =>
    request<{ conversation: Conversation | null; messages: ChatMessageRecord[] }>(
      keys.history(conversationId),
    ),
  conversations: () => request<{ conversations: Conversation[] }>(keys.conversations()),
  newConversation: () =>
    request<{ conversation: Conversation }>("/api/chat/conversations", { method: "POST" }),
};

// ── Chat streaming (SSE) ──────────────────────────────────────────────────

export interface ChatStreamBody {
  conversationId?: string | null;
  message: string;
  mode: "chat" | "voice";
  location?: { lat: number; lng: number } | null;
}

export interface ChatStreamDone {
  messageId: string;
  conversationId: string;
  text: string;
  activity: ToolActivity[];
}

export interface ChatStreamCallbacks {
  onToken?: (text: string) => void;
  onTool?: (label: string, status: "start" | "ok" | "error") => void;
  onDone?: (payload: ChatStreamDone) => void;
  onError?: (message: string) => void;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException ? err.name === "AbortError" : false;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return "Connection lost";
}

/**
 * POST /api/chat and stream ChatStreamEvents.
 * Resolves when the stream ends (or is aborted); never throws.
 */
export async function postChatStream(
  body: ChatStreamBody,
  callbacks: ChatStreamCallbacks = {},
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (!isAbort(err)) callbacks.onError?.(messageOf(err));
    return;
  }

  if (!res.ok || !res.body) {
    let message = `Assistant unavailable (${res.status})`;
    try {
      const data: unknown = await res.json();
      if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") {
        message = (data as { error: string }).error;
      }
    } catch {
      /* ignore */
    }
    callbacks.onError?.(message);
    return;
  }

  const dispatch = (raw: string) => {
    const payload = raw
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!payload || payload === "[DONE]") return;
    let event: ChatStreamEvent;
    try {
      event = JSON.parse(payload) as ChatStreamEvent;
    } catch {
      return;
    }
    switch (event.type) {
      case "token":
        callbacks.onToken?.(event.text);
        break;
      case "tool":
        callbacks.onTool?.(event.label, event.status);
        break;
      case "done":
        callbacks.onDone?.({
          messageId: event.messageId,
          conversationId: event.conversationId,
          text: event.text,
          activity: event.activity,
        });
        break;
      case "error":
        callbacks.onError?.(event.message);
        break;
    }
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        dispatch(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf("\n\n");
      }
    }
    if (buffer.trim()) dispatch(buffer);
  } catch (err) {
    if (!isAbort(err)) callbacks.onError?.(messageOf(err));
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

// ── Stats / settings / data ───────────────────────────────────────────────

export type SettingsPatch = {
  tz?: string;
  theme?: MaskedSettings["theme"];
  ai?: Partial<AISettings>;
  voice?: Partial<VoiceSettings>;
  notifications?: Partial<NotificationSettings>;
  google?: Partial<GoogleSettings>;
};

export const statsApi = {
  get: () => request<StatsSummary>(keys.stats()),
};

export const settingsApi = {
  get: () => request<MaskedSettings>(keys.settings()),
  patch: (patch: SettingsPatch) =>
    request<MaskedSettings>("/api/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  models: (provider: AISettings["provider"]) =>
    request<{ models: ModelInfo[] }>(keys.models(provider)),
  test: (provider: AISettings["provider"]) =>
    request<{ ok: boolean; message: string }>("/api/settings/test", {
      method: "POST",
      body: JSON.stringify({ provider }),
    }),
};

export const dataApi = {
  exportUrl: "/api/data/export",
  import: (payload: string) =>
    request<{ imported: number }>("/api/data/import", { method: "POST", body: payload }),
};

// ── Push ──────────────────────────────────────────────────────────────────

export const pushApi = {
  vapid: () => request<{ publicKey: string }>(keys.vapid()),
  subscribe: (subscription: PushSubscriptionJSON) =>
    request<{ ok: true }>("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ subscription }),
    }),
  test: () => request<{ ok: true }>("/api/push/test", { method: "POST" }),
};

// ── Google / calendar ─────────────────────────────────────────────────────

export const googleApi = {
  status: () => request<GoogleStatus>(keys.googleStatus()),
  disconnect: () => request<{ ok: true }>("/api/google/disconnect", { method: "POST" }),
  scan: () =>
    request<{ created: number }>("/api/google/scan", {
      method: "POST",
      timeoutMs: SLOW_TIMEOUT_MS,
    }),
};

export const calendarApi = {
  today: () => request<{ events: CalendarEvent[]; connected: boolean }>(keys.calendarToday()),
};

// ── Places / nearby / location / logbook ──────────────────────────────────

export const placesApi = {
  search: (q: string, near?: { lat: number; lng: number } | null) =>
    request<{ places: PlaceResult[] }>(
      `/api/places/search${query({ q, lat: near?.lat, lng: near?.lng })}`,
    ),
};

export const locationApi = {
  report: (lat: number, lng: number) =>
    request<{ ok: true }>("/api/location", { method: "POST", body: JSON.stringify({ lat, lng }) }),
};

export const nearbyApi = {
  list: (near?: { lat: number; lng: number } | null) =>
    request<{ tasks: NearbyTask[]; located: number }>(
      `/api/nearby${query({ lat: near?.lat, lng: near?.lng })}`,
    ),
};

export const logbookApi = {
  list: (days = 30) => request<{ days: LogbookDay[] }>(`/api/logbook${query({ days })}`),
};
