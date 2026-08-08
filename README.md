# DoneX

Your AI-enabled task companion — tasks, notes, voice, and a daily plan, on your own server.

- **AI chat & voice assistant** that manages tasks for you
- **Morning briefing** and a one-tap **day plan**
- **Tasks** with projects, tags, subtasks, recurrence
- **Keep-style notes & checklists**
- **Unified inbox** with AI triage, fed by Gmail + an SMS webhook
- **Google Calendar** awareness
- **Push reminders**
- **Weekly review** with streaks
- **Installable PWA**, dark/light

Next.js 15 (App Router, TypeScript, strict) + SQLite (`better-sqlite3`) + Tailwind CSS.
Ships as a single Docker image with `output: "standalone"` — no external database, no
required third-party services beyond your own AI provider key.

## Quick start (local)

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. First run creates your PIN.

## Deploy on Railway

1. Push this repo to GitHub.
2. Railway → New Project → **Deploy from GitHub repo**.
3. Add a **Volume**, mount path `/data`.
4. Service Variables: `DATA_DIR=/data`, `APP_URL=https://<your-domain>` (set this
   after Railway assigns a domain — Settings → Networking → Generate Domain).
5. Deploy, open the URL, create your PIN.

> SQLite lives on the volume — run **one replica only**, don't scale horizontally.

## Connect your AI

Settings → AI Models: paste an OpenAI and/or Anthropic API key, then pick a model
from the live list — or point at a custom OpenAI-compatible endpoint (OpenRouter,
a local server, etc).

## Install on your phone

- **Android (Chrome):** ⋮ menu → **Add to Home screen** / **Install**.
- **iPhone (Safari):** Share → **Add to Home Screen**.
- Push notifications on iOS need iOS 16.4+ and the installed (Home Screen) app —
  they don't work in the Safari tab.

## Google Calendar & Gmail

Connect Google in Settings to see today's calendar events in your briefing/plan and
to pull unread inbox mail into DoneX's inbox for AI triage.

Setup walkthrough: [docs/SETUP-GOOGLE.md](docs/SETUP-GOOGLE.md)

## Text-message capture

Forward SMS messages into your DoneX inbox from an Android phone (MacroDroid/Tasker
→ webhook), so texted reminders and errands show up for AI triage alongside email.

Setup walkthrough: [docs/SETUP-SMS.md](docs/SETUP-SMS.md)

## Voice

Uses your browser's built-in speech recognition and system voices — no audio is
sent to a third-party voice API. Works best in Chrome on Android. The Voice screen
has a hands-free mode that keeps listening after the assistant replies.

## Data & backup

Settings → Data → **Export JSON** downloads a full backup.

The SQLite database file lives at `$DATA_DIR/donex.db`. On Railway, that's on your
mounted volume, so backups only need to grab that one file.

## Development

| Script | What it does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build (`output: "standalone"`) |
| `npm run start` | Run the production build locally |
| `npm test` | Run the test suite (Vitest) |

## Security notes

- Single-user PIN, scrypt-hashed, with rate-limited login attempts.
- AI provider keys and Google credentials are stored server-side in SQLite and
  never sent to the client — the Settings API only returns masked presence markers.
- Sessions use an httpOnly cookie.
- Put DoneX behind HTTPS — Railway does this for you automatically.
