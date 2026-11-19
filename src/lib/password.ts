/**
 * Node-only salted password hashing and strong password generation.
 * Never import in Edge middleware or client bundles.
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const PREFIX = "scrypt.v1.";
const KEY_LEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, KEY_LEN).toString("hex");
  return `${PREFIX}${salt}.${derived}`;
}

export function verifyPasswordHash(password: string, stored: string): boolean {
  if (!stored.startsWith(PREFIX)) return false;
  const rest = stored.slice(PREFIX.length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return false;
  const salt = rest.slice(0, dot);
  const expectedHex = rest.slice(dot + 1);
  if (!salt || !expectedHex) return false;
  try {
    const expected = Buffer.from(expectedHex, "hex");
    const actual = scryptSync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGITS = "23456789";
const SYMBOLS = "!@#$%^&*-_";
const ALL = UPPER + LOWER + DIGITS + SYMBOLS;

/** Generate an unambiguous, cryptographically random password for user creation. */
export function generateStrongPassword(length = 24): string {
  const chars: string[] = [
    UPPER[randomBytes(1)[0] % UPPER.length],
    LOWER[randomBytes(1)[0] % LOWER.length],
    DIGITS[randomBytes(1)[0] % DIGITS.length],
    SYMBOLS[randomBytes(1)[0] % SYMBOLS.length],
  ];
  while (chars.length < length) {
    chars.push(ALL[randomBytes(1)[0] % ALL.length]);
  }
  // Fisher-Yates shuffle with CSPRNG bytes
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
