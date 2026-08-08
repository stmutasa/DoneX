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
4. **Action** → **Connectivity** (or **HTTP**) → **HTTP Request**:
   - Method: `POST`
   - URL: `https://YOUR-APP-DOMAIN/api/ingest/sms`
   - Content type: `application/json`
   - Request headers: `x-donex-token` = *(your capture token)*
   - Body:
     ```json
     {"from":"[sms_name] [sms_number]","body":"[sms_message]"}
     ```
     The bracketed tokens (`[sms_name]`, `[sms_number]`, `[sms_message]`) are
     MacroDroid **magic text** — don't type them literally, insert each one
     with the `…` magic-text picker button in the field.
5. **Save**, name it `DoneX SMS`.
6. When prompted, grant MacroDroid the **SMS** permission — without it the
   trigger never fires.
7. **Test:** text yourself, then check the DoneX Inbox for the new item.

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

Expect `{"ok":true,"id":"..."}`. A wrong/missing token returns `401`.

## Privacy

Messages go straight from your phone to **your own** DoneX server over
HTTPS — no intermediary SMS or forwarding service sees the content. The
endpoint is token-gated; treat the capture token like a password. It's
visible any time in Settings → Capture, so you can re-check or copy it into
a new automation if you ever need to rebuild the macro.
