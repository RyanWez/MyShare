import { NextRequest, NextResponse } from "next/server";
import { authenticator } from "otplib";
import {
  SESSION_COOKIE,
  authRequired,
  createSessionValue,
  sessionCookieOptions,
  missingPasswordInProduction,
} from "@/lib/auth";
import { dbApi } from "@/lib/db";
import { verifyPasswordHash } from "@/lib/password";
import { clientIp, limitFromEnv, rateLimit, rateLimitReset } from "@/lib/rateLimit";

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const IP_BUCKET = "login:ip";
const GLOBAL_BUCKET = "login:global";

const tooMany = (retryAfterSec: number) =>
  NextResponse.json(
    {
      ok: false,
      error: `Too many failed attempts. Try again in ${Math.ceil(retryAfterSec / 60)} min.`,
    },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
  );

/** Lets the login page discover whether 2FA is active. */
export async function GET() {
  const totpRequired = !!process.env.AUTH_TOTP_SECRET;
  return NextResponse.json({ ok: true, required: authRequired(), totpRequired });
}

export async function POST(req: NextRequest) {
  if (missingPasswordInProduction()) {
    return NextResponse.json(
      { ok: false, error: "AUTH_PASSWORD is not configured on the server" },
      { status: 503 }
    );
  }

  const ip = clientIp(req);
  const ipLimit = limitFromEnv("LOGIN_MAX_ATTEMPTS", 10);
  const globalLimit = limitFromEnv("LOGIN_MAX_ATTEMPTS_GLOBAL", 60);

  const ipPeek = rateLimit(IP_BUCKET, ip, ipLimit, LOGIN_WINDOW_MS, { peek: true });
  if (!ipPeek.allowed) return tooMany(ipPeek.retryAfterSec);
  const globalPeek = rateLimit(GLOBAL_BUCKET, "all", globalLimit, LOGIN_WINDOW_MS, {
    peek: true,
  });
  if (!globalPeek.allowed) return tooMany(globalPeek.retryAfterSec);

  let username = "";
  let password = "";
  let totpCode = "";
  try {
    const body = await req.json();
    username = typeof body?.username === "string" ? body.username.trim() : "";
    password = typeof body?.password === "string" ? body.password : "";
    totpCode = typeof body?.totpCode === "string" ? body.totpCode.trim() : "";
  } catch {
    return NextResponse.json({ ok: false, error: "bad request" }, { status: 400 });
  }

  const spendAttempt = () => {
    rateLimit(IP_BUCKET, ip, ipLimit, LOGIN_WINDOW_MS);
    rateLimit(GLOBAL_BUCKET, "all", globalLimit, LOGIN_WINDOW_MS);
  };

  if (!username || !password) {
    spendAttempt();
    return NextResponse.json(
      { ok: false, error: "Username and password are required" },
      { status: 401 }
    );
  }

  let user;
  try {
    user = await dbApi.getUserAuthByUsername(username);
  } catch (err) {
    console.error("[auth/login] Database error:", err);
    return NextResponse.json(
      { ok: false, error: "Database unavailable — please try again" },
      { status: 503 }
    );
  }

  if (!user || !verifyPasswordHash(password, user.password_hash)) {
    spendAttempt();
    return NextResponse.json({ ok: false, error: "Invalid username or password" }, { status: 401 });
  }

  if (!user.is_active) {
    spendAttempt();
    return NextResponse.json(
      { ok: false, error: "This account has been disabled by Admin" },
      { status: 403 }
    );
  }

  const totpSecret = process.env.AUTH_TOTP_SECRET;
  if (totpSecret) {
    if (!totpCode || !authenticator.check(totpCode, totpSecret)) {
      spendAttempt();
      return NextResponse.json({ ok: false, error: "Wrong auth code" }, { status: 401 });
    }
  }

  const value = await createSessionValue(user.id, user.token_version);
  if (!value) {
    return NextResponse.json(
      { ok: false, error: "AUTH_SECRET is not configured on the server" },
      { status: 503 }
    );
  }

  rateLimitReset(IP_BUCKET, ip);

  const res = NextResponse.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      roleName: user.role_name,
      rexId: user.rex_id,
      rexName: user.rex_name,
      permissions: user.permissions,
    },
  });
  res.cookies.set(SESSION_COOKIE, value, sessionCookieOptions);
  return res;
}
