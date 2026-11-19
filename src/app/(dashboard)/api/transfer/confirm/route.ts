import { NextRequest, NextResponse } from "next/server";
import { dbApi } from "@/lib/db";
import { apiOk, registerMyShare, normalizeMsisdn } from "@/lib/mytel";
import { getValidToken } from "@/lib/tokens";
import { canAccessSim, requireSession } from "@/lib/authz";

export const dynamic = "force-dynamic";

// Step 2: confirm transfer with OTP. Body: { phone, receiver, amount, otp }
export async function POST(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.transfer.execute);
  if (!auth.ok) return auth.response;

  try {
    const { phone, receiver, amount, otp } = await req.json();
    if (!phone || !receiver || !amount || !otp)
      return NextResponse.json(
        { ok: false, error: "phone, receiver, amount, otp required" },
        { status: 400 }
      );

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 500 || amt > 5000)
      return NextResponse.json({ ok: false, error: "Amount must be 500–5000 Ks" }, { status: 400 });

    const sender = normalizeMsisdn(phone);
    const receiverMsisdn = normalizeMsisdn(receiver);
    const sim = await dbApi.getSim(sender);
    if (!sim) return NextResponse.json({ ok: false, error: "SIM not found" }, { status: 404 });
    if (!canAccessSim(auth.user, sim)) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }

    const ts = await getValidToken(sim);
    if (ts.needsLogin || !ts.token) {
      return NextResponse.json({
        ok: false,
        needsLogin: true,
        error: "Token expired — re-login required",
      });
    }

    const fee = Math.round(amt * 0.05);
    const transfer = await dbApi.addTransfer({
      sender_phone: sender,
      receiver_phone: receiver,
      rex_id: sim.rex_id ?? auth.user.rex_id,
      created_by_user_id: auth.user.id,
      amount: amt,
      fee,
      status: "pending",
    });

    let result;
    try {
      result = await registerMyShare(ts.token, sender, receiverMsisdn, amt, otp);
    } catch (err: any) {
      const message = err?.message || "Failed to reach Mytel server";
      await dbApi.updateTransfer(transfer.id, {
        status: "failed",
        error_code: null,
        message,
      });
      return NextResponse.json(
        { ok: false, error: message, transferId: transfer.id },
        { status: 502 }
      );
    }

    const ok = apiOk(result.errorCode);

    await dbApi.updateTransfer(transfer.id, {
      status: ok ? "success" : "failed",
      error_code: result.errorCode,
      message: result.message ?? null,
    });

    if (ok) {
      await dbApi.debitSimBalance(sender, amt + fee);
    }

    return NextResponse.json({
      ok,
      errorCode: result.errorCode,
      message: result.message,
      transferId: transfer.id,
    });
  } catch (err: any) {
    console.error(`[transfer/confirm] ${err?.message || err}`);
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to reach Mytel server" },
      { status: 502 }
    );
  }
}
