import { NextRequest, NextResponse } from "next/server";
import { loginWithPassword, normalizeMsisdn, apiOk } from "@/lib/mytel";
import { persistLogin } from "@/lib/session";
import { canAccessSim, requireSession, resolveScopedRexId } from "@/lib/authz";
import { dbApi } from "@/lib/db";

export async function POST(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.sims.addLogin);
  if (!auth.ok) return auth.response;

  try {
    const { phone, password, rexId: rawRexId } = await req.json();
    if (!phone || !password)
      return NextResponse.json({ ok: false, error: "phone & password required" }, { status: 400 });

    const msisdn = normalizeMsisdn(phone);
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

    const result = await loginWithPassword(msisdn, password);

    if (!apiOk(result.errorCode) || !result.result?.access_token) {
      return NextResponse.json({
        ok: false,
        errorCode: result.errorCode,
        message: result.message ?? "Login failed",
      });
    }

    const { subscriptionId, balance } = await persistLogin(msisdn, result.result, null, {
      rexId: targetRexId,
      addedByUserId: auth.user.id,
    });

    return NextResponse.json({ ok: true, subscriptionId, balance });
  } catch (err: any) {
    console.error("[login-password] Error:", err);
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
