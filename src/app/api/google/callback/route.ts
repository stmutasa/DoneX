import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/lib/auth";
import {
  GOOGLE_NOT_CONFIGURED,
  GOOGLE_NO_REFRESH_TOKEN,
  consumeState,
  exchangeCode,
  resolveOrigin,
} from "@/lib/google/oauth";
import { settingsRepo } from "@/lib/db/repos";
import { lastScanState, scanGmail } from "@/lib/google/gmail";

export const dynamic = "force-dynamic";

/** Set once Google has been connected on this install. */
const CONNECTED_BEFORE_KEY = "google.connectedBefore";

/**
 * A short code for a failed token exchange. Settings turns codes into fixed
 * copy and never shows the raw text, so the full message goes to the log.
 */
function exchangeFailure(message: string): string {
  if (message === GOOGLE_NOT_CONFIGURED) return "not_configured";
  if (message === GOOGLE_NO_REFRESH_TOKEN) return "no_refresh_token";
  const code = message.split(":")[0].trim().toLowerCase();
  if (code === "invalid_client" || code === "unauthorized_client") return "invalid_client";
  if (code === "redirect_uri_mismatch") return "redirect_uri_mismatch";
  return "exchange_failed";
}

export async function GET(request: NextRequest) {
  const gate = await requireOwner();
  if (gate) return gate;

  const origin = resolveOrigin(request);
  const params = request.nextUrl.searchParams;
  const fail = (reason: string) =>
    NextResponse.redirect(
      `${origin}/settings/google?google=error&reason=${encodeURIComponent(reason.slice(0, 200))}`,
      302
    );

  const denied = params.get("error");
  if (denied) return fail(denied);

  if (!consumeState(params.get("state"))) return fail("state_mismatch");

  const code = params.get("code");
  if (!code) return fail("missing_code");

  try {
    await exchangeCode(code, request);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[google callback] token exchange failed:", message);
    return fail(exchangeFailure(message));
  }

  // Connecting Google grants the gmail.readonly scope for exactly one
  // reason — feeding the Inbox — so the first connect turns scanning on by
  // default (the user can flip it back off in Settings). Reconnecting, which
  // is routine after an expired token, keeps whatever they chose since. Either
  // way, when scanning is on, run a pass now rather than making them wait up
  // to an hour for the next scheduler tick.
  const firstConnect = !settingsRepo.getKV(CONNECTED_BEFORE_KEY) && !lastScanState().at;
  settingsRepo.setKV(CONNECTED_BEFORE_KEY, "1");
  if (firstConnect) settingsRepo.updateApp({ google: { gmailScanEnabled: true } });
  if (settingsRepo.getApp().google.gmailScanEnabled) {
    scanGmail().catch((err) => console.error("[google callback] initial scan", err));
  }

  return NextResponse.redirect(`${origin}/settings/google?google=connected`, 302);
}
