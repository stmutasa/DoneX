/**
 * Google OAuth 2.0 (installed-app style, single user) over plain fetch.
 * The googleapis SDK is intentionally not used — REST only.
 */
import "server-only";
import crypto from "crypto";
import { googleRepo, settingsRepo, type GoogleTokens } from "@/lib/db/repos";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
const STATE_KEY = "google.oauthState";

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.readonly",
];

export const GOOGLE_NOT_CONNECTED = "Google is not connected — connect it in Settings";
export const GOOGLE_EXPIRED = "Google connection expired — reconnect in Settings";
const GOOGLE_NOT_CONFIGURED =
  "Google client ID / secret are missing — add them in Settings";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

// ── Config ─────────────────────────────────────────────────────────────────

export function googleCreds(): { clientId: string; clientSecret: string } {
  const g = settingsRepo.getApp().google;
  return { clientId: g.clientId.trim(), clientSecret: g.clientSecret.trim() };
}

export function googleConfigured(): boolean {
  const { clientId, clientSecret } = googleCreds();
  return !!clientId && !!clientSecret;
}

export function isGoogleConnected(): boolean {
  return !!googleRepo.get();
}

/** Public origin for OAuth redirects: APP_URL wins, else the (proxy-aware) request origin. */
export function resolveOrigin(request: Request): string {
  const configured = process.env.APP_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const url = new URL(request.url);
  const forwardedProto = firstHeaderValue(request, "x-forwarded-proto");
  const forwardedHost = firstHeaderValue(request, "x-forwarded-host");
  const proto = forwardedProto || url.protocol.replace(":", "") || "https";
  const host = forwardedHost || request.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

function firstHeaderValue(request: Request, name: string): string {
  const raw = request.headers.get(name);
  if (!raw) return "";
  return raw.split(",")[0].trim();
}

export function redirectUriFor(request: Request): string {
  return `${resolveOrigin(request)}/api/google/callback`;
}

// ── Authorize / state ──────────────────────────────────────────────────────

/** Builds the consent URL and persists a one-shot CSRF state value. */
export function buildAuthorizeUrl(request: Request): string {
  const { clientId } = googleCreds();
  if (!clientId) throw new Error(GOOGLE_NOT_CONFIGURED);
  const state = crypto.randomBytes(16).toString("hex");
  settingsRepo.setKV(STATE_KEY, state);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUriFor(request),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** Verifies and consumes the stored state value. */
export function consumeState(state: string | null): boolean {
  const expected = settingsRepo.getKV(STATE_KEY);
  settingsRepo.setKV(STATE_KEY, "");
  if (!expected || !state) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(state);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Token exchange / refresh ───────────────────────────────────────────────

function expiryFrom(expiresIn: number | undefined): string {
  const seconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 3600;
  return new Date(Date.now() + (seconds - 60) * 1000).toISOString();
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  let parsed: TokenResponse = {};
  try {
    parsed = (await res.json()) as TokenResponse;
  } catch {
    parsed = { error: `http_${res.status}` };
  }
  if (!res.ok && !parsed.error) parsed.error = `http_${res.status}`;
  return parsed;
}

async function fetchUserEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { email?: string };
    return data.email ?? null;
  } catch {
    return null;
  }
}

/** Exchanges an authorization code and stores the resulting tokens. */
export async function exchangeCode(code: string, request: Request): Promise<GoogleTokens> {
  const { clientId, clientSecret } = googleCreds();
  if (!clientId || !clientSecret) throw new Error(GOOGLE_NOT_CONFIGURED);

  const body = await postToken(
    new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUriFor(request),
      grant_type: "authorization_code",
    })
  );
  if (!body.access_token) {
    throw new Error(body.error_description || body.error || "Token exchange failed");
  }

  const existing = googleRepo.get();
  // Google omits refresh_token on silent re-consent — keep the stored one.
  const refreshToken = body.refresh_token || existing?.refreshToken || "";
  if (!refreshToken) {
    throw new Error(
      "Google did not return a refresh token — revoke DoneX access in your Google account and retry"
    );
  }

  const tokens: GoogleTokens = {
    accessToken: body.access_token,
    refreshToken,
    expiry: expiryFrom(body.expires_in),
    email: (await fetchUserEmail(body.access_token)) ?? existing?.email ?? "",
    scopes: (body.scope || GOOGLE_SCOPES.join(" ")).split(" ").filter(Boolean),
  };
  googleRepo.save(tokens);
  return tokens;
}

async function refreshTokens(tokens: GoogleTokens): Promise<string> {
  const { clientId, clientSecret } = googleCreds();
  if (!clientId || !clientSecret) throw new Error(GOOGLE_NOT_CONFIGURED);

  const body = await postToken(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refreshToken,
      grant_type: "refresh_token",
    })
  );
  if (!body.access_token) {
    if (body.error === "invalid_grant") {
      googleRepo.clear();
      throw new Error(GOOGLE_EXPIRED);
    }
    throw new Error(body.error_description || body.error || "Google token refresh failed");
  }

  googleRepo.save({
    ...tokens,
    accessToken: body.access_token,
    refreshToken: body.refresh_token || tokens.refreshToken,
    expiry: expiryFrom(body.expires_in),
    scopes: body.scope ? body.scope.split(" ").filter(Boolean) : tokens.scopes,
  });
  return body.access_token;
}

/** Valid access token, refreshing when expired (or when force is set). */
export async function getAccessToken(opts: { force?: boolean } = {}): Promise<string> {
  const tokens = googleRepo.get();
  if (!tokens) throw new Error(GOOGLE_NOT_CONNECTED);
  const expiresAt = Date.parse(tokens.expiry);
  const fresh = Number.isFinite(expiresAt) && expiresAt > Date.now();
  if (!opts.force && fresh && tokens.accessToken) return tokens.accessToken;
  return refreshTokens(tokens);
}

/** Authenticated Google API fetch with a single refresh-and-retry on 401. */
export async function googleFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const send = (token: string) =>
    fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
    });

  const res = await send(await getAccessToken());
  if (res.status !== 401) return res;
  return send(await getAccessToken({ force: true }));
}

/** Human-readable message for a failed Google API response. */
export async function googleApiError(res: Response, what: string): Promise<Error> {
  let detail = "";
  try {
    const data = (await res.json()) as { error?: { message?: string } | string };
    detail =
      typeof data.error === "string" ? data.error : data.error?.message ?? "";
  } catch {
    detail = "";
  }
  return new Error(`${what} failed (${res.status})${detail ? `: ${detail}` : ""}`);
}
