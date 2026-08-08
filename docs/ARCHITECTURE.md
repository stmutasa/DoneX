# DoneX Architecture

Single-user, self-hosted AI task companion. Next.js 15 (App Router, TS strict)
+ SQLite (better-sqlite3) on a Railway volume. Installable PWA. All AI calls
run server-side; keys never reach the client.

## Module map & ownership

| Area | Path | Notes |
|---|---|---|
| Shared types | `src/lib/types.ts` | Source of truth for cross-module shapes |
| DB + repos | `src/lib/db/` | Schema + typed repositories (complete) |
| Auth | `src/lib/auth.ts` | PIN (scrypt), opaque session cookie (complete) |
| Recurrence | `src/lib/recurrence.ts` | `nextOccurrence(rule, from, tz)` (complete) |
| Utils | `src/lib/utils.ts` | ids, tz-aware date keys (complete) |
| AI engine | `src/lib/ai/` | Facade `index.ts` signatures are FROZEN |
| Quick-add parser | `src/lib/quickparse.ts` | chrono-node NL parsing |
| Google | `src/lib/google/` | OAuth + Calendar + Gmail via fetch (no SDK) |
| Push | `src/lib/push.ts` | web-push; VAPID keys generated on demand → settings.vapid |
| Scheduler | `src/lib/scheduler.ts` | interval loop started from `src/instrumentation.ts` |
| API routes | `src/app/api/**` | Thin: zod-validate → repo/facade call → JSON |
| UI | `src/app/**`, `src/components/**`, `src/hooks/**` | Client fetches via SWR |

## Conventions (all code)

- Imports via `@/` alias. TypeScript strict; **no `any`** unless unavoidable.
- Every API handler starts with `const gate = await requireSession(); if (gate) return gate;`
  — except: `/api/auth/*`, `/api/health`, `/api/ingest/sms` (token-gated), `/api/push/vapid` is session-gated too.
- API errors: `NextResponse.json({ error: string }, { status })`. Success: plain JSON, no envelope.
- Route handlers export `export const dynamic = "force-dynamic"` (DB reads must not be cached).
- Validate request bodies with zod; coerce nothing silently.
- No new npm dependencies. No env vars beyond `DATA_DIR`, `PORT`, `APP_URL`.
- Server code may use Node APIs; anything under `components/`/`hooks/` must be client-safe.
- Dates: store UTC ISO strings; use `localDateKey(date, tz)` helpers for local-day logic; tz comes from `settingsRepo.getApp().tz`.

## API catalog

Auth
- `POST /api/auth/setup` `{pin: string(4-8 digits), tz: string}` → 200 `{ok:true}` + session cookie. Only allowed when no PIN exists. Sets `ingestToken` (random 24 hex) and `onboardedAt`, stores tz.
- `POST /api/auth/login` `{pin}` → 200 `{ok:true}` + cookie · 401 bad pin · 429 rate-limited
- `POST /api/auth/logout` → `{ok:true}`

Tasks
- `GET /api/tasks?view=today|upcoming|anytime|all&projectId&tag&q&includeDone=1` → `{tasks: Task[]}`
- `POST /api/tasks` TaskDraft → `{task}` (400 on empty title)
- `PATCH /api/tasks/[id]` TaskPatch → `{task}` · 404
- `DELETE /api/tasks/[id]` → `{ok:true}`
- `POST /api/tasks/[id]/complete` `{done: boolean}` → `{task, recurred: boolean}`
- `POST /api/tasks/reorder` `{ids: string[]}` → `{ok:true}`
- `GET /api/tags` → `{tags: string[]}`

Projects
- `GET /api/projects` → `{projects}` · `POST /api/projects` `{name, color?, icon?}` → `{project}`
- `PATCH /api/projects/[id]` → `{project}` · `DELETE /api/projects/[id]` → `{ok:true}`

Notes
- `GET /api/notes?q=` → `{notes}` · `POST /api/notes` Partial<Note> → `{note}`
- `PATCH /api/notes/[id]` → `{note}` · `DELETE /api/notes/[id]` → `{ok:true}`

Inbox
- `GET /api/inbox?status=new|all` → `{items, newCount}`
- `POST /api/inbox` `{content, source?: "quick"}` → `{item}` (manual capture)
- `POST /api/inbox/[id]/resolve` `{action: "task"|"note"|"dismiss", task?: TaskDraft, note?: {title, content}}`
  → `{ok:true, taskId?}`. action=task creates the task (use provided draft, else suggestion.task, else `{title: content}`); note appends `content` to note titled by payload (create if missing); dismiss just closes.
- `POST /api/inbox/triage` `{id?: string}` → `{items}` — AI-fill suggestions for one/all `new` items (skip already-suggested).
- `POST /api/ingest/sms` header `x-donex-token: <ingestToken>` body `{from: string, body: string, receivedAt?: string}` → 200 `{ok:true, id}` · 401 bad token. Dedupe key: `sms:<sha1(from|body|receivedAt-minute)>`.

Assistant
- `POST /api/chat` `{conversationId?: string|null, message: string, mode: "chat"|"voice"}` → **SSE** stream of `ChatStreamEvent` (`data: <json>\n\n` lines, ends after `done`/`error` event).
- `GET /api/chat/history?conversationId=` → `{conversation, messages}`; omit id → most recent conversation or `{conversation: null, messages: []}`.
- `GET /api/chat/conversations` → `{conversations}` · `POST /api/chat/conversations` → `{conversation}` (new)
- `GET /api/assistant/briefing?refresh=1` → `{briefing}` (today, cached per day)
- `POST /api/assistant/plan` `{refresh?: boolean}` → `{plan}` · `POST /api/assistant/plan/accept` `{blocks: PlanBlock[], addToCalendar?: boolean}` → `{plan}`
- `GET /api/assistant/review?refresh=1` → `{review}` (current ISO week)

Data / stats / settings
- `GET /api/stats` → `StatsSummary`
- `GET /api/settings` → `MaskedSettings` · `PATCH /api/settings` DeepPartial<AppSettings> → `MaskedSettings`
  (never echo secrets; a secret field arriving as empty string means "unchanged", the literal `"__clear__"` clears it; after key changes call `autoPickModelIfNeeded()`)
- `GET /api/settings/models?provider=openai|anthropic|custom` → `{models: ModelInfo[]}`
- `POST /api/settings/test` `{provider}` → `{ok, message}`
- `GET /api/data/export` → JSON download · `POST /api/data/import` (export JSON) → `{imported}`
- `GET /api/health` → `{ok:true}` (no auth)

Push / Google
- `GET /api/push/vapid` → `{publicKey}` (generates+persists VAPID pair on first call)
- `POST /api/push/subscribe` `{subscription}` → `{ok:true}` · `POST /api/push/test` → `{ok:true}`
- `GET /api/google/status` → `GoogleStatus`
- `GET /api/google/connect` → 302 to Google consent (uses APP_URL or request origin for redirect_uri `/api/google/callback`)
- `GET /api/google/callback` → exchanges code, stores tokens, 302 → `/settings?google=connected`
- `POST /api/google/disconnect` → `{ok:true}` · `POST /api/google/scan` → `{created: number}` (Gmail → inbox items)
- `GET /api/calendar/today` → `{events: CalendarEvent[], connected: boolean}`

## AI engine notes

- Providers: OpenAI-compatible (`https://api.openai.com/v1` or custom base URL) and Anthropic (`https://api.anthropic.com/v1`), via `fetch` + hand-parsed SSE. Utility calls (triage, quick parse) use same active model.
- Agent loop: system prompt (persona + today/tz + open-task digest + today's calendar + projects list) → stream text; on tool_use pause, execute against repos, feed results back, continue; max 6 tool rounds.
- Tools: `create_task`, `update_task`, `complete_task`, `delete_task`, `list_tasks`, `create_project`, `add_note`, `append_checklist`, `list_notes`, `get_calendar_today`, `get_stats`, `save_day_plan`. Every mutation emits a `tool` SSE event with a human label.
- Voice mode: same loop; system prompt adds "answers are spoken aloud — be concise, no markdown, no lists".
- Briefing/plan/review: single JSON-output calls (strict JSON prompt + robust parse), persisted via repos.

## Scheduler (every 60s tick)

1. Reminders: `tasksRepo.dueForReminder(now)` → push per task → `markNotified`.
2. Morning briefing: at `notifications.briefingTime` (±1 min, once per local day, KV `sched.lastBriefingDay`): generate briefing (if AI configured) + push summary.
3. Weekly review: at weekly day/time (KV `sched.lastReviewWeek`): generate + push.
4. Gmail scan: hourly (KV `sched.lastGmailScan`) when connected & enabled: unread primary inbox since last scan → inbox items → auto-triage each.
All steps wrapped in try/catch — the loop must never die. Push failures with 404/410 remove the subscription.

## PWA

`public/manifest.webmanifest` (standalone, portrait, theme #0b0e13, icons 192/512/maskable + apple-touch), `public/sw.js` (network-first for navigations with `/offline` fallback, stale-while-revalidate for `/_next/static` & icons, skip `/api`, `push` → showNotification({title, body, data.url}), `notificationclick` → focus/open url). Registered from the app shell in production only.
