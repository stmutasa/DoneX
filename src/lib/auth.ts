import "server-only";
import crypto from "crypto";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { pushRepo, sessionsRepo, settingsRepo } from "@/lib/db/repos";

export const SESSION_COOKIE = "donex_session";

// ── PIN hashing (scrypt) ───────────────────────────────────────────────────

export function hashPin(pin: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pin.normalize(), salt, 64);
  return `s1:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  try {
    const [v, saltHex, hashHex] = stored.split(":");
    if (v !== "s1") return false;
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(pin.normalize(), salt, 64);
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ── Login rate limiting (in-memory; single-process app) ────────────────────
//
// Only wrong PINs count. Each miss counts against:
//  - its client: five free misses, then a lockout that doubles with every
//    further miss (1 min, 2, 4 … up to an hour). Only the owner's PIN clears
//    the streak, since the partner's must not buy more guesses at the
//    owner's; otherwise it fades after a day without misses;
//  - everyone except the owner's known devices, together: at most 20 misses
//    in any 24 hours, so spreading guesses over many addresses buys nothing.
// A browser that has signed in as the owner carries a signed device cookie
// and is held only to its own limit, so a stranger working through PINs
// can't lock the owner out of a device they already use.

const FREE_MISSES = 5;
const FIRST_LOCK_MS = 60_000;
const MAX_LOCK_MS = 60 * 60_000;
const STRANGER_MISSES_PER_DAY = 20;
const DAY_MS = 24 * 60 * 60_000;

/** Who is trying to sign in: one of the owner's devices, or else an address. */
export interface LoginClient {
  key: string;
  /** a browser that has signed in as the owner */
  trusted: boolean;
}

export type LoginAttempt =
  | { retryAfter: number }
  | {
      /** Records who the PIN signed in as (null for a miss). True when the
       *  owner should hear about it: this miss just closed sign-in to all
       *  but the owner's known devices. */
      settle: (signedInAs: "owner" | "partner" | null) => boolean;
    };

const misses = new Map<string, { count: number; lastAt: number }>();
let strangerMisses: number[] = [];
let lastStrangerAlertAt = -Infinity;

function lockMs(count: number): number {
  if (count < FREE_MISSES) return 0;
  return Math.min(FIRST_LOCK_MS * 2 ** (count - FREE_MISSES), MAX_LOCK_MS);
}

/**
 * Claims one PIN check for `client`, or says how many seconds to wait. The
 * check and the count are one synchronous step: the attempt counts as a miss
 * straight away and a right PIN takes it back in `settle`, so a burst of
 * parallel requests can't all pass on the same stale count.
 */
export function claimLoginAttempt(client: LoginClient, now = Date.now()): LoginAttempt {
  strangerMisses = strangerMisses.filter((t) => now - t < DAY_MS);
  if (misses.size > 500) {
    for (const [key, m] of misses) if (now - m.lastAt >= DAY_MS) misses.delete(key);
  }

  // A day without a miss forgives the streak.
  const prev = misses.get(client.key);
  const count = prev && now - prev.lastAt < DAY_MS ? prev.count : 0;
  let until = prev && count ? prev.lastAt + lockMs(count) : 0;
  if (!client.trusted && strangerMisses.length >= STRANGER_MISSES_PER_DAY) {
    until = Math.max(until, strangerMisses[0] + DAY_MS);
  }
  if (until > now) return { retryAfter: Math.ceil((until - now) / 1000) };

  misses.set(client.key, { count: count + 1, lastAt: now });
  if (!client.trusted) strangerMisses.push(now);
  const closesStrangers = !client.trusted && strangerMisses.length >= STRANGER_MISSES_PER_DAY;

  return {
    settle(signedInAs) {
      if (signedInAs) {
        // A right PIN isn't a miss, but only the owner's wipes earlier ones.
        if (signedInAs === "owner" || !prev || count === 0) misses.delete(client.key);
        else misses.set(client.key, { count, lastAt: prev.lastAt });
        if (!client.trusted) {
          const i = strangerMisses.lastIndexOf(now);
          if (i >= 0) strangerMisses.splice(i, 1);
        }
        return false;
      }
      if (!closesStrangers || now - lastStrangerAlertAt < DAY_MS) return false;
      lastStrangerAlertAt = now;
      return true;
    },
  };
}

// Test seam: forget every recorded miss.
export function __resetLoginLimiterForTests(): void {
  misses.clear();
  strangerMisses = [];
  lastStrangerAlertAt = -Infinity;
}

// ── The owner's devices ────────────────────────────────────────────────────

/** Marks a browser that has signed in as the owner (see the login limiter). */
export const DEVICE_COOKIE = "donex_device";
const DEVICE_SECRET_KEY = "auth.deviceSecret";

/** Signs device cookies. Random, made once and kept, so a PIN change doesn't
 *  turn the owner's own signed-out devices into strangers. */
function deviceSecret(): string {
  let secret = settingsRepo.getKV(DEVICE_SECRET_KEY);
  if (!secret) {
    secret = crypto.randomBytes(32).toString("hex");
    settingsRepo.setKV(DEVICE_SECRET_KEY, secret);
  }
  return secret;
}

function signDevice(payload: string): string {
  return crypto.createHmac("sha256", deviceSecret()).update(payload).digest("hex");
}

/** A device in use gets its mark re-dated once it is this old. */
const DEVICE_RENEW_MS = 30 * DAY_MS;

/** A cookie value for one of the owner's devices:
 *  `id.owner.issuedAt.signature`, with issuedAt in seconds. */
export function mintOwnerDeviceCookie(
  id = crypto.randomBytes(16).toString("hex"),
  issuedAt = Date.now(),
): string {
  const payload = `${id}.owner.${Math.floor(issuedAt / 1000)}`;
  return `${payload}.${signDevice(payload)}`;
}

/** What a genuine owner-device cookie says, else null. The older undated
 *  form, `id.owner.signature`, still counts, as if issued long ago. */
function readOwnerDevice(value: string | undefined): { id: string; issuedAt: number } | null {
  const parts = (value ?? "").split(".");
  const sig = parts.pop();
  const [id, role, issued] = parts;
  if (!id || role !== "owner" || !sig || parts.length > 3) return null;
  if (issued !== undefined && !/^\d+$/.test(issued)) return null;
  const expected = Buffer.from(signDevice(parts.join(".")));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return { id, issuedAt: issued === undefined ? 0 : Number(issued) * 1000 };
}

/**
 * Who is trying to sign in. Railway's edge drops any X-Forwarded-For a client
 * sends and puts the client's address first, so the address is X-Real-IP when
 * set, else the leftmost forwarded entry. A host that passes forged headers
 * through only hands out fresh per-client streaks; the shared cap still holds.
 */
export function loginClient(
  deviceCookie: string | undefined,
  forwardedFor: string | null,
  realIp: string | null = null,
): LoginClient {
  const device = readOwnerDevice(deviceCookie);
  if (device) return { key: `device:${device.id}`, trusted: true };
  const first = (forwardedFor ?? "").split(",")[0]?.trim();
  return { key: `ip:${realIp?.trim() || first || "unknown"}`, trusted: false };
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge: Math.floor(sessionsRepo.maxAgeMs / 1000),
    path: "/",
  };
}

/**
 * Marks this browser as one of the owner's, and re-dates the mark (with a
 * fresh cookie lifetime) once it is a month old, so a device the owner keeps
 * using never lapses along with one session. Only ever for an owner session.
 */
export async function rememberOwnerDevice(now = Date.now()): Promise<void> {
  const jar = await cookies();
  const known = readOwnerDevice(jar.get(DEVICE_COOKIE)?.value);
  if (known && now - known.issuedAt < DEVICE_RENEW_MS) return;
  // Re-dating keeps the id, and with it the device's miss streak.
  jar.set(DEVICE_COOKIE, mintOwnerDeviceCookie(known?.id, now), cookieOptions());
}

// ── PIN collisions ─────────────────────────────────────────────────────────
// Each hash has its own salt, so only a sign-in with the shared PIN can tell
// that the two PINs are the same. The note it leaves is tied to both hashes,
// so changing either PIN retires it.

const PIN_COLLISION_KEY = "auth.pinCollision";

function pinPairRef(): string {
  const settings = settingsRepo.getApp();
  return crypto
    .createHash("sha256")
    .update(`${settings.pinHash}|${settings.joint.partnerPinHash}`)
    .digest("hex")
    .slice(0, 32);
}

/** Records that a PIN just matched both the owner's and the partner's hash. */
export function notePinCollision(): void {
  settingsRepo.setKV(PIN_COLLISION_KEY, pinPairRef());
}

/** Whether the current two PINs are known to be the same. */
export function pinsCollide(): boolean {
  return settingsRepo.getKV(PIN_COLLISION_KEY) === pinPairRef();
}

// ── Session helpers ────────────────────────────────────────────────────────

export async function createSession(role: "owner" | "partner" = "owner"): Promise<void> {
  const h = await headers();
  const token = sessionsRepo.create(h.get("user-agent") ?? "", role);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, cookieOptions());
  // Only the owner's sign-in makes a known device. The partner's leaves an
  // existing mark alone: on a shared device her guesses at the owner's PIN
  // are held to that device's own streak, which her PIN never clears.
  if (role === "owner") await rememberOwnerDevice();
}

/** Ends this browser's session, and pushes to the device it signed up. */
export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    sessionsRepo.destroy(token);
    pushRepo.pruneSignedOut();
  }
  jar.delete(SESSION_COOKIE);
}

/**
 * Signs out every session of `role` except `keepToken`, and stops pushes to
 * the devices those sessions signed up. A PIN change uses it so that whoever
 * knew the old PIN is locked out at once.
 */
export function endSessions(role: "owner" | "partner", keepToken?: string): void {
  sessionsRepo.destroyRole(role, keepToken);
  pushRepo.pruneSignedOut();
}

/** The signed-in session's token and role, or null when signed out. */
export async function currentSession(): Promise<{ token: string; role: "owner" | "partner" } | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const role = token ? sessionsRepo.roleOf(token) : null;
  return token && role ? { token, role } : null;
}

export async function isAuthed(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return !!token && sessionsRepo.verify(token);
}

/** Role of the signed-in session, or null when signed out. */
export async function sessionRole(): Promise<"owner" | "partner" | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return token ? sessionsRepo.roleOf(token) : null;
}

export type AuthState = "setup" | "login" | "ok";

/** For server components: which gate applies right now */
export async function getAuthState(): Promise<AuthState> {
  const settings = settingsRepo.getApp();
  if (!settings.pinHash) return "setup";
  return (await isAuthed()) ? "ok" : "login";
}

/**
 * For API route handlers. Usage:
 *   const gate = await requireSession(); if (gate) return gate;
 */
export async function requireSession(): Promise<NextResponse | null> {
  if (await isAuthed()) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * Owner-only routes — everything except the joint task surface. A partner
 * session gets a 403 the UI reads as "not yours to see".
 */
export async function requireOwner(): Promise<NextResponse | null> {
  const role = await sessionRole();
  if (role === "owner") return null;
  if (role === "partner") {
    return NextResponse.json({ error: "This part is not shared" }, { status: 403 });
  }
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
