/**
 * Session signing & Edge-compatible verification for the multi-user console.
 *
 * Uses the Web Crypto API (async) so the exact same verification logic runs in
 * Edge middleware (`src/middleware.ts`) and in Node route handlers.
 */

export const SESSION_COOKIE = "myshare_session";
const SESSION_TTL_SEC = 7 * 24 * 60 * 60; // 7 days

export interface ParsedSession {
  userId: number;
  tokenVersion: number;
  exp: number;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return toHex(digest);
}

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return toHex(sig);
}

/** Constant-time string comparison to avoid timing side channels. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** True when authentication is armed (env password or DB configured). */
export function authEnabled(): boolean {
  return Boolean(process.env.AUTH_PASSWORD || process.env.DATABASE_URL);
}

/**
 * In production or whenever auth/DB is configured, every route requires a session.
 */
export function authRequired(): boolean {
  return authEnabled() || isProduction();
}

export async function verifyPassword(candidate: string): Promise<boolean> {
  const expected = process.env.AUTH_PASSWORD;
  if (!expected) return false;
  return safeEqual(await sha256Hex(candidate), await sha256Hex(expected));
}

function secret(): string | null {
  const s = process.env.AUTH_SECRET;
  const totpSuffix = process.env.AUTH_TOTP_SECRET || "";
  if (s) return s + totpSuffix;
  if (!isProduction()) return "dev-insecure-secret" + totpSuffix;
  return null;
}

/** Build a signed session value: `<userId>.<tokenVersion>.<expUnixSec>.<hmac>` */
export async function createSessionValue(
  userId: number,
  tokenVersion: number
): Promise<string | null> {
  const s = secret();
  if (!s) return null;
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const payload = `${userId}.${tokenVersion}.${exp}`;
  return `${payload}.${await hmacHex(s, payload)}`;
}

export async function parseSessionCookie(
  value: string | undefined | null
): Promise<ParsedSession | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [userIdRaw, tvRaw, expRaw, sig] = parts;
  const userId = Number(userIdRaw);
  const tokenVersion = Number(tvRaw);
  const exp = Number(expRaw);
  if (
    !Number.isInteger(userId) ||
    userId <= 0 ||
    !Number.isInteger(tokenVersion) ||
    tokenVersion <= 0 ||
    !Number.isFinite(exp)
  ) {
    return null;
  }
  if (exp < Math.floor(Date.now() / 1000)) return null;
  const s = secret();
  if (!s) return null;
  const payload = `${userIdRaw}.${tvRaw}.${expRaw}`;
  if (!safeEqual(sig, await hmacHex(s, payload))) return null;
  return { userId, tokenVersion, exp };
}

export async function isSessionValid(value: string | undefined | null): Promise<boolean> {
  if (!authRequired()) return true;
  return (await parseSessionCookie(value)) !== null;
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: isProduction(),
  path: "/",
  maxAge: SESSION_TTL_SEC,
};

export const clearedSessionCookieOptions = {
  ...sessionCookieOptions,
  maxAge: 0,
};

/** Marker used by the login page to explain a misconfigured deployment. */
export function missingPasswordInProduction(): boolean {
  return isProduction() && !process.env.AUTH_PASSWORD;
}
