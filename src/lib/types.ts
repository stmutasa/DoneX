/**
 * DoneX shared domain types & API contracts.
 *
 * This file is the single source of truth for shapes crossing module
 * boundaries (DB ⇄ AI ⇄ scheduler ⇄ UI). Server-only code lives elsewhere;
 * this file must stay importable from client components (no Node imports).
 */

// ── Core domain ────────────────────────────────────────────────────────────

export type Priority = 0 | 1 | 2 | 3; // 0 none · 1 low · 2 medium · 3 high

export type TaskStatus = "open" | "done";

export interface RecurrenceRule {
  freq: "daily" | "weekly" | "monthly" | "yearly";
  /** every N units, default 1 */
  interval?: number;
  /** for weekly: 0=Sun … 6=Sat */
  byWeekday?: number[];
  /** for monthly: 1–31 (clamped to month length) */
  byMonthDay?: number;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  status: TaskStatus;
  priority: Priority;
  /** ISO datetime (UTC) or null. If allDay, time component is 00:00 local encoded at creation. */
  dueAt: string | null;
  allDay: boolean;
  projectId: string | null;
  tags: string[];
  /** parent task id → this is a subtask */
  parentId: string | null;
  recurrence: RecurrenceRule | null;
  sort: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** populated on list reads */
  subtasks?: Task[];
}

export interface TaskDraft {
  title: string;
  notes?: string;
  priority?: Priority;
  dueAt?: string | null;
  allDay?: boolean;
  projectId?: string | null;
  tags?: string[];
  parentId?: string | null;
  recurrence?: RecurrenceRule | null;
}

export type TaskPatch = Partial<TaskDraft> & { sort?: number };

export interface TaskListFilter {
  view?: "today" | "upcoming" | "anytime" | "all";
  projectId?: string;
  tag?: string;
  q?: string;
  includeDone?: boolean;
  /** ISO date bound for scheduler queries */
  dueBefore?: string;
}

export interface Project {
  id: string;
  name: string;
  color: string; // hex
  icon: string; // single emoji
  sort: number;
  archived: boolean;
  createdAt: string;
  /** populated on list reads */
  openCount?: number;
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
}

export interface Note {
  id: string;
  title: string;
  kind: "note" | "checklist";
  /** markdown-ish body for kind=note */
  content: string;
  /** for kind=checklist */
  items: ChecklistItem[];
  color: string | null; // token name: null|"amber"|"coral"|"sage"|"sky"|"violet"|"sand"
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export type InboxSource = "sms" | "gmail" | "quick";
export type InboxStatus = "new" | "resolved" | "dismissed";

export interface InboxSuggestion {
  action: "task" | "note" | "ignore";
  /** short explanation shown to the user */
  reason: string;
  task?: TaskDraft;
  note?: { title: string; content: string };
}

export interface InboxItem {
  id: string;
  source: InboxSource;
  /** e.g. gmail message id or sms sender — used for dedupe */
  externalId: string | null;
  fromLabel: string;
  content: string;
  receivedAt: string;
  status: InboxStatus;
  suggestion: InboxSuggestion | null;
  resolvedTaskId: string | null;
  createdAt: string;
}

// ── Planning / briefing / review ───────────────────────────────────────────

export interface PlanBlock {
  start: string; // "09:00" local
  end: string; // "09:45"
  label: string;
  taskIds: string[];
  kind: "focus" | "break" | "errand" | "event";
}

export interface DayPlan {
  dateLocal: string; // YYYY-MM-DD
  summary: string;
  blocks: PlanBlock[];
  accepted: boolean;
  generatedAt: string;
}

export interface Briefing {
  dateLocal: string;
  greeting: string;
  /** 2–4 sentence narrative for the morning */
  narrative: string;
  /** ids of the 1–3 tasks the AI suggests focusing on */
  focusTaskIds: string[];
  generatedAt: string;
}

export interface WeeklyReview {
  weekKey: string; // YYYY-Www (ISO week)
  completedCount: number;
  createdCount: number;
  streak: number;
  bestDay: string | null;
  narrative: string;
  suggestions: string[];
  generatedAt: string;
}

export interface StatsSummary {
  today: { done: number; open: number };
  streakDays: number;
  /** last 7 days, oldest first */
  week: { dateLocal: string; done: number }[];
  totalOpen: number;
  overdue: number;
}

// ── Chat / assistant ───────────────────────────────────────────────────────

export type ChatRole = "user" | "assistant";

export interface ToolActivity {
  label: string; // human friendly, e.g. "Added task “Buy milk”"
  ok: boolean;
}

export interface ChatMessageRecord {
  id: string;
  conversationId: string;
  role: ChatRole;
  text: string;
  /** tool actions performed while producing an assistant message */
  activity: ToolActivity[];
  createdAt: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

/** Server-sent events emitted by POST /api/chat */
export type ChatStreamEvent =
  | { type: "token"; text: string }
  | { type: "tool"; label: string; status: "start" | "ok" | "error" }
  | {
      type: "done";
      messageId: string;
      conversationId: string;
      /** full final text — clients use this for TTS in voice mode */
      text: string;
      activity: ToolActivity[];
    }
  | { type: "error"; message: string };

// ── Settings ───────────────────────────────────────────────────────────────

export type AIProviderKind = "openai" | "anthropic" | "custom";

export interface AISettings {
  provider: AIProviderKind;
  /** model id for the active provider; empty string = auto-pick newest */
  model: string;
  openaiKey: string;
  anthropicKey: string;
  /** OpenAI-compatible endpoint for "custom" (e.g. OpenRouter, local) */
  customBaseUrl: string;
  customKey: string;
  customModel: string;
}

export interface VoiceSettings {
  voiceURI: string; // "" = system default
  rate: number; // 0.5–2, default 1
  autoListen: boolean; // hands-free loop after assistant speaks
}

export interface NotificationSettings {
  remindersEnabled: boolean;
  briefingEnabled: boolean;
  briefingTime: string; // "07:00" local
  weeklyReviewEnabled: boolean;
  weeklyDay: number; // 0=Sun … 6=Sat
  weeklyTime: string; // "18:00"
}

export interface GoogleSettings {
  clientId: string;
  clientSecret: string;
  gmailScanEnabled: boolean;
}

export interface AppSettings {
  pinHash: string; // "" until setup
  tz: string; // IANA, e.g. "America/New_York"
  theme: "system" | "light" | "dark";
  ai: AISettings;
  voice: VoiceSettings;
  notifications: NotificationSettings;
  google: GoogleSettings;
  ingestToken: string;
  vapid: { publicKey: string; privateKey: string } | null;
  onboardedAt: string | null;
}

/** GET /api/settings — secrets replaced by presence markers */
export interface MaskedSettings
  extends Omit<AppSettings, "pinHash" | "ai" | "google" | "vapid"> {
  hasPin: boolean;
  ai: Omit<AISettings, "openaiKey" | "anthropicKey" | "customKey"> & {
    openaiKey: SecretMark;
    anthropicKey: SecretMark;
    customKey: SecretMark;
  };
  google: Omit<GoogleSettings, "clientSecret"> & { clientSecret: SecretMark };
  pushConfigured: boolean;
}

export interface SecretMark {
  set: boolean;
  last4: string;
}

// ── Google integration ─────────────────────────────────────────────────────

export interface CalendarEvent {
  id: string;
  title: string;
  start: string; // ISO
  end: string; // ISO
  allDay: boolean;
  location: string | null;
}

export interface GoogleStatus {
  configured: boolean; // client id+secret present
  connected: boolean;
  email: string | null;
  scopes: string[];
}

// ── Model registry ─────────────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  label: string;
}

// ── Misc API shapes ────────────────────────────────────────────────────────

export interface ApiError {
  error: string;
}

export const NOTE_COLORS = ["amber", "coral", "sage", "sky", "violet", "sand"] as const;

export const PRIORITY_META: Record<Priority, { label: string; short: string }> = {
  0: { label: "No priority", short: "—" },
  1: { label: "Low", short: "P3" },
  2: { label: "Medium", short: "P2" },
  3: { label: "High", short: "P1" },
};
