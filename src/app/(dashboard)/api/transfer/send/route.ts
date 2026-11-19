import { NextRequest, NextResponse } from "next/server";
import { dbApi } from "@/lib/db";
import { requestTransferOtp, normalizeMsisdn, apiOk } from "@/lib/mytel";
import { getValidToken } from "@/lib/tokens";
import { canAccessSim, requireSession } from "@/lib/authz";

export const dynamic = "force-dynamic";

// Step 1: trigger OTP for a transfer. Body: { phone }
export async function POST(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.transfer.execute);
  if (!auth.ok) return auth.response;

  try {
    const { phone } = await req.json();
    if (!phone) return NextResponse.json({ ok: false, error: "phone required" }, { status: 400 });

    const msisdn = normalizeMsisdn(phone);
    const sim = await dbApi.getSim(msisdn);
    if (!sim) return NextResponse.json({ ok: false, error: "SIM not found" }, { status: 404 });
    if (!canAccessSim(auth.user, sim)) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }
    if (!sim.subscription_id)
      return NextResponse.json({ ok: false, error: "No subscription id — re-login this SIM" });

    const ts = await getValidToken(sim);
    if (ts.needsLogin || !ts.token) {
      return NextResponse.json({ ok: false, needsLogin: true, error: "Token expired — re-login required" });
    }

    const result = await requestTransferOtp(ts.token, sim.subscription_id);
    const ok = apiOk(result.errorCode);

    return NextResponse.json({
      ok,
      errorCode: result.errorCode,
      message: result.message,
      needsLogin: false,
    });
  } catch (err: any) {
    console.error(`[transfer/send] ${err?.message || err}`);
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to reach Mytel server" },
      { status: 502 }
    );
  }
}
