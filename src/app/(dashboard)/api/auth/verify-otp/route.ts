import { NextRequest, NextResponse } from "next/server";
import { loginWithOtp, confirmRegister, normalizeMsisdn, apiOk } from "@/lib/mytel";
import { persistLogin } from "@/lib/session";
import { canAccessSim, requireSession, resolveScopedRexId } from "@/lib/authz";
import { dbApi } from "@/lib/db";
import { rateLimit, rateLimitReset } from "@/lib/rateLimit";

const OTP_VERIFY_WINDOW_MS = 15 * 60 * 1000;
const PHONE_BUCKET = "otp:verify:phone";
const USER_BUCKET = "otp:verify:user";
const PHONE_LIMIT = 8;
const USER_LIMIT = 20;

export async function POST(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.sims.addLogin);
  if (!auth.ok) return auth.response;

  try {
    const { phone, otp, reqId, subscriptionId: hint, rexId: rawRexId } = await req.json();
    if (!phone || !otp)
      return NextResponse.json({ ok: false, error: "phone & otp required" }, { status: 400 });

    const msisdn = normalizeMsisdn(phone);
    if (!/^959\d{9}$/.test(msisdn)) {
      return NextResponse.json({ ok: false, error: "invalid phone number" }, { status: 400 });
    }
    const existing = await dbApi.getSim(msisdn);
    if (existing && !canAccessSim(auth.user, existing)) {
      return NextResponse.json(
        { ok: false, error: "This SIM belongs to another Rex group" },
        { status: 403 }
      );
    }

    const targetRexId = resolveScopedRexId(
      auth.user,
      rawRexId !== undefined && rawRexId !== null ? String(rawRexId) : null
    );
    const registering = typeof reqId === "string" && reqId.length > 0;

    if (process.env.NODE_ENV !== "production") {
      console.log(
        `[verify-otp] ${new Date().toISOString()} phone=${msisdn} flow=${registering ? "register" : "login"} otp=${String(otp).slice(0, 2)}**** reqId=${registering ? "yes" : "no"}`
      );
    }

    const phonePeek = rateLimit(PHONE_BUCKET, msisdn, PHONE_LIMIT, OTP_VERIFY_WINDOW_MS, {
      peek: true,
    });
    const userPeek = rateLimit(USER_BUCKET, String(auth.user.id), USER_LIMIT, OTP_VERIFY_WINDOW_MS, {
      peek: true,
    });
    if (!phonePeek.allowed || !userPeek.allowed) {
      const retryAfterSec = Math.max(
        phonePeek.allowed ? 0 : phonePeek.retryAfterSec,
        userPeek.allowed ? 0 : userPeek.retryAfterSec
      );
      return NextResponse.json(
        { ok: false, error: "Too many failed attempts. Try again later." },
        { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
      );
    }

    const result = registering
      ? await confirmRegister(msisdn, reqId, otp)
      : await loginWithOtp(msisdn, otp);

    if (!apiOk(result.errorCode) || !result.result?.access_token) {
      rateLimit(PHONE_BUCKET, msisdn, PHONE_LIMIT, OTP_VERIFY_WINDOW_MS);
      rateLimit(USER_BUCKET, String(auth.user.id), USER_LIMIT, OTP_VERIFY_WINDOW_MS);
      const isUnauth =
        result.errorCode === 401 ||
        String(result.message ?? "")
          .toLowerCase()
          .includes("unauthorized");
      const friendly =
        !registering && isUnauth
          ? "Mytel sent a new code to your phone. Please wait for the second SMS and enter the new 6-digit code. (First code expired)"
          : (result.message ?? (registering ? "Could not create the account" : "Login failed"));
      return NextResponse.json({
        ok: false,
        registered: false,
        errorCode: result.errorCode,
        message: friendly,
      });
    }

    rateLimitReset(PHONE_BUCKET, msisdn);

    const { subscriptionId, balance } = await persistLogin(
      msisdn,
      result.result,
      typeof hint === "string" ? hint : null,
      { rexId: targetRexId, addedByUserId: auth.user.id }
    );

    return NextResponse.json({
      ok: true,
      registered: registering,
      subscriptionId,
      balance,
    });
  } catch (err: any) {
    console.error(`[verify-otp] ${err?.message || err}`);
    return NextResponse.json(
      {
        ok: false,
        errorCode: -1,
        message: err?.message || "Failed to reach Mytel server",
      },
      { status: 502 }
    );
  }
}
