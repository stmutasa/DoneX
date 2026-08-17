# Text-message capture (SMS → DoneX inbox)

Forward incoming SMS on your Android phone straight into your DoneX inbox, so
texted errands and reminders get AI-triaged alongside email. This uses a
free automation app on your phone to POST each SMS to a DoneX webhook — no
third-party SMS service, no phone number sharing.

Your capture token is in DoneX → **Settings** → **Capture** (tap to copy).
It gates the endpoint: requests without the right token are rejected.

## Option A: MacroDroid (recommended, free tier is enough)

1. Install **MacroDroid** from the Play Store.
2. **Add Macro**.
3. **Trigger** → **SMS Received** → leave sender/content as **Any**.
4. **Action** → **Connectivity** (or **HTTP**) → **HTTP Request**. The action
   has four tabs; fill them in like this:

   **Settings**
   - Request method: **POST** — the default is GET, which the endpoint
     rejects with `405`. This is the single most common setup mistake.
   - Enter url: `https://YOUR-APP-DOMAIN/api/ingest/sms`
   - Everything else stays default: *Block next actions* off, *Allow any
     certificate* off, *Follow redirects* on, timeout 30, no authorization,
     no client certificate, no proxy, "Don't save output".

   **Header Params**
   - `x-donex-token` = *(your capture token)*

   **Content Body**
   - Content type: `application/json`
   - Body:
     ```json
     {"from":"[sms_name] [sms_number]","body":"[sms_message]"}
     ```
     The bracketed tokens (`[sms_name]`, `[sms_number]`, `[sms_message]`) are
     MacroDroid **magic text** — don't type them literally, insert each one
     with the `…` magic-text picker button in the field.

   **Query Params** — leave empty.
5. **Save**, name it `DoneX SMS`.
6. When prompted, grant MacroDroid the **SMS** permission — without it the
   trigger never fires.
7. **Test:** text yourself, then check the DoneX Inbox for the new item.

### If a message arrives looking mangled

MacroDroid pastes the message straight into the JSON above, so a text
containing a `"` or spanning several lines can produce invalid JSON. The
endpoint repairs that template automatically, but if anything still looks
wrong you can sidestep the quoting entirely: clear the **Content Body**, and
on the **Query Params** tab add `from` = `[sms_name] [sms_number]` and `body`
= `[sms_message]`. MacroDroid URL-encodes those, so no punctuation can break
them. (Trade-off: message text then appears in your server's request logs.)

## Option B: Tasker

1. **Profile:** Event → **Received Text** → sender left blank (any).
2. **Task action:** Net → **HTTP Request**.
3. Method `POST`, URL `https://YOUR-APP-DOMAIN/api/ingest/sms`, headers
   `Content-Type:application/json` and `x-donex-token:YOUR_TOKEN`, body
   `{"from":"%SMSRF","body":"%SMSRB"}` (Tasker's built-in SMS-received
   variables).
4. Enable the profile; grant Tasker SMS permission when prompted.

## Test with curl

Useful to confirm the token/URL work before wiring up the phone:

```bash
curl -X POST https://YOUR-APP-DOMAIN/api/ingest/sms \
  -H "content-type: application/json" \
  -H "x-donex-token: YOUR_TOKEN" \
  -d '{"from":"Test","body":"curl test message"}'
```

Expect `{"ok":true,"id":"..."}`. Reading the failures: `401` = wrong or
missing token, `405` = the macro is still set to GET, `400` = no message
text arrived at all.

## Privacy

Messages go straight from your phone to **your own** DoneX server over
HTTPS — no intermediary SMS or forwarding service sees the content. The
endpoint is token-gated; treat the capture token like a password. It's
visible any time in Settings → Capture, so you can re-check or copy it into
a new automation if you ever need to rebuild the macro.
