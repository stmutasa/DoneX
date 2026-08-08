# Connect Google Calendar & Gmail

DoneX uses your own Google Cloud OAuth client — no shared app, no third-party
relay. Tokens are stored only in your DoneX database.

## 1. Create a Google Cloud project

1. Go to [console.cloud.google.com](https://console.cloud.google.com).
2. Top bar → project picker → **New Project**.
3. Name it `DoneX` → **Create**.

## 2. Enable the APIs

1. Left sidebar (or search bar) → **APIs & Services** → **Library**.
2. Search for **Google Calendar API** → **Enable**.
3. Search for **Gmail API** → **Enable**.

## 3. Configure the OAuth consent screen

1. **APIs & Services** → **OAuth consent screen**.
2. User type: **External** → **Create**.
3. App name: `DoneX`. Fill in your own email for support/contact.
4. Scopes step: you can skip adding scopes here — DoneX requests them directly
   at connect time (see below).
5. Test users step: add **your own Google account**.
6. Save. The app stays in **Testing** mode — that's fine for personal use.

> **Testing mode note:** refresh tokens for apps in Testing mode expire after
> **7 days**, so Google will silently disconnect DoneX weekly and you'll need
> to reconnect. To avoid that, go back to the OAuth consent screen and click
> **Publish App**. An unverified app is fine for personal, single-user use —
> Google's verification review is only required for apps used by the public.
> After publishing, connecting will show an "unverified app" warning screen;
> click **Advanced** → **Go to DoneX (unsafe)** / **Continue** to proceed.
> This warning is expected and safe to dismiss for your own app.

## 4. Create OAuth credentials

1. **APIs & Services** → **Credentials** → **Create Credentials** →
   **OAuth client ID**.
2. Application type: **Web application**.
3. Name: anything, e.g. `DoneX web`.
4. Under **Authorized redirect URIs**, add:

   ```
   https://YOUR-APP-DOMAIN/api/google/callback
   ```

   Replace `YOUR-APP-DOMAIN` with your real Railway domain. This must match
   **exactly** — including `https://` and no trailing slash.

   Also add, for local development:

   ```
   http://localhost:3000/api/google/callback
   ```

5. **Create**. Copy the **Client ID** and **Client Secret** shown.

## 5. Connect in DoneX

1. Open DoneX → **Settings** → **Google**.
2. Paste the **Client ID** and **Client Secret** → **Connect**.
3. You're sent to Google's consent screen. Sign in, and if you see the
   unverified-app warning, click **Continue**.
4. Approve the requested permissions. You're redirected back to DoneX,
   connected.

## Scopes used

| Scope | Why |
|---|---|
| `calendar.events` | Read your events for the briefing/today view, and create events when you accept AI-suggested plan blocks to your calendar. |
| `gmail.readonly` | Scan unread mail in your Primary inbox so it can be triaged into the DoneX inbox. Read-only — DoneX never sends or deletes mail. |

(DoneX also requests `openid` + `email` at connect time, only to show which
Google account is connected.)

## Troubleshooting

**`redirect_uri_mismatch`**
The redirect URI DoneX sent doesn't exactly match one in your OAuth client.
Check scheme (`https://`), host, and that there's no trailing slash. Local
dev must use `http://localhost:3000/api/google/callback` exactly.

**`invalid_grant` after it worked fine for a week**
Your OAuth client is still in Testing mode — refresh tokens expire after 7
days. Go to the OAuth consent screen and **Publish App** (see step 3), then
reconnect in DoneX Settings.

**`403 access_denied` on the consent screen**
Your Google account isn't listed as a test user yet (only matters while the
app is in Testing mode). Add it under OAuth consent screen → Test users, or
publish the app.
