import "server-only";
import crypto from "crypto";
import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { sessionsRepo, settingsRepo } from "@/lib/db/repos";

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

const attempts: number[] = [];

export function loginRateLimited(): boolean {
  const now = Date.now();
  while (attempts.length && now - attempts[0] > 60_000) attempts.shift();
  return attempts.length >= 8;
}

export function recordLoginAttempt(): void {
  attempts.push(Date.now());
}

// ── Session helpers ────────────────────────────────────────────────────────

export async function createSession(role: "owner" | "partner" = "owner"): Promise<void> {
  const h = await headers();
  const token = sessionsRepo.create(h.get("user-agent") ?? "", role);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 400,
    path: "/",
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) sessionsRepo.destroy(token);
  jar.delete(SESSION_COOKIE);
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
