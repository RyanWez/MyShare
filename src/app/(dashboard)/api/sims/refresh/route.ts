import { NextRequest, NextResponse } from "next/server";
import { dbApi } from "@/lib/db";
import { getAccountDetail, getBalance, listSubscriptions, normalizeMsisdn } from "@/lib/mytel";
import { getValidToken } from "@/lib/tokens";
import { canAccessSim, requireSession } from "@/lib/authz";

export const dynamic = "force-dynamic";

// Refresh balance + account expiry for one SIM: POST /api/sims/refresh { phone }
export async function POST(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.sims.refresh);
  if (!auth.ok) return auth.response;

  try {
    const { phone } = await req.json();
    if (!phone) return NextResponse.json({ ok: false, error: "phone required" }, { status: 400 });

    const msisdn = normalizeMsisdn(phone);
    if (!/^959\d{9}$/.test(msisdn)) {
      return NextResponse.json({ ok: false, error: "Invalid phone number" }, { status: 400 });
    }

    const sim = await dbApi.getSim(msisdn);
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

    const bal = await getBalance(ts.token, msisdn);
    if (!bal) return NextResponse.json({ ok: false, error: "Could not fetch balance" });

    let subId = bal.subId || sim.subscription_id || "";
    if (!subId) {
      const subs = await listSubscriptions(ts.token).catch(() => []);
      const mine = subs.find((s) => normalizeMsisdn(s.isdn) === msisdn) ?? subs[0];
      if (mine?.id) subId = mine.id;
    }

    const detail = subId ? await getAccountDetail(ts.token, subId).catch(() => null) : null;

    const nowSec = Math.floor(Date.now() / 1000);
    await dbApi.upsertSim(msisdn, {
      balance: bal.mainAmount,
      balance_checked_at: nowSec,
      subscription_id: subId || sim.subscription_id,
      ...(detail
        ? {
            bill_expire_at: detail.billExpireAt,
            block_one_way: detail.blockOneWay,
            block_two_way: detail.blockTwoWay,
            sim_status_text: detail.currentStatus,
          }
        : {}),
    });

    return NextResponse.json({
      ok: true,
      balance: bal.mainAmount,
      subId,
      billExpireAt: detail?.billExpireAt ?? sim.bill_expire_at,
      blockOneWay: detail?.blockOneWay ?? sim.block_one_way,
      blockTwoWay: detail?.blockTwoWay ?? sim.block_two_way,
      simStatusText: detail?.currentStatus ?? sim.sim_status_text,
    });
  } catch (err: any) {
    console.error("[sims/refresh] Error:", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to reach Mytel server" },
      { status: 502 }
    );
  }
}
