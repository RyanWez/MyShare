import { NextRequest, NextResponse } from "next/server";
import { dbApi } from "@/lib/db";
import { getAccountDetail, getBalance, listSubscriptions, normalizeMsisdn } from "@/lib/mytel";
import { getValidToken } from "@/lib/tokens";
import { canAccessSim, requireSession } from "@/lib/authz";
import { SIM_REFRESH_COOLDOWN_SEC } from "@/lib/constants";
import { fmtCountdown } from "@/lib/format";
import { hasUnlimitedRefresh } from "@/lib/permissions";
import { limitFromEnv, rateLimit } from "@/lib/rateLimit";

export const dynamic = "force-dynamic";

const USER_BURST_BUCKET = "sims:refresh:user";
const USER_BURST_WINDOW_MS = 60_000;
const DEFAULT_USER_BURST_MAX = 12;

// One refresh in flight per SIM at a time so concurrent double-clicks cannot race past
// the cooldown check before the first Mytel read updates `balance_checked_at`.
const inFlight = new Set<string>();

// Refresh balance + account expiry for one SIM: POST /api/sims/refresh { phone }
export async function POST(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.sims.refresh);
  if (!auth.ok) return auth.response;

  let msisdn = "";
  let acquiredLock = false;
  try {
    const { phone } = await req.json();
    if (!phone) return NextResponse.json({ ok: false, error: "phone required" }, { status: 400 });

    msisdn = normalizeMsisdn(phone);
    if (!/^959\d{9}$/.test(msisdn)) {
      return NextResponse.json({ ok: false, error: "Invalid phone number" }, { status: 400 });
    }

    const sim = await dbApi.getSim(msisdn);
    if (!sim) return NextResponse.json({ ok: false, error: "SIM not found" }, { status: 404 });
    if (!canAccessSim(auth.user, sim)) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }

    if (inFlight.has(msisdn)) {
      return NextResponse.json(
        {
          ok: false,
          rateLimited: true,
          reason: "in_flight",
          retryAfterSec: 2,
          error: "Already refreshing this SIM — please wait.",
        },
        { status: 429, headers: { "Retry-After": "2" } }
      );
    }
    inFlight.add(msisdn);
    acquiredLock = true;

    const bypassLimit = hasUnlimitedRefresh(
      auth.user.role_name,
      auth.user.permissions,
      auth.user.is_env_admin
    );

    if (!bypassLimit) {
      const nowSec = Math.floor(Date.now() / 1000);
      if (sim.status === "active" && sim.balance !== null && sim.balance_checked_at !== null) {
        const elapsedSec = nowSec - sim.balance_checked_at;
        if (elapsedSec >= 0 && elapsedSec < SIM_REFRESH_COOLDOWN_SEC) {
          const retryAfterSec = SIM_REFRESH_COOLDOWN_SEC - elapsedSec;
          return NextResponse.json(
            {
              ok: false,
              rateLimited: true,
              reason: "sim_cooldown",
              retryAfterSec,
              checkedAgoSec: elapsedSec,
              lastCheckedAt: sim.balance_checked_at,
              cooldownUntil: sim.balance_checked_at + SIM_REFRESH_COOLDOWN_SEC,
              error: `No need to refresh — checked ${fmtCountdown(elapsedSec)} ago. Try again in ${fmtCountdown(retryAfterSec)}.`,
            },
            { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
          );
        }
      }

      const burstLimit = limitFromEnv("SIM_REFRESH_BURST_MAX", DEFAULT_USER_BURST_MAX);
      const userKey = String(auth.user.id);
      const burstPeek = rateLimit(USER_BURST_BUCKET, userKey, burstLimit, USER_BURST_WINDOW_MS, {
        peek: true,
      });
      if (!burstPeek.allowed) {
        return NextResponse.json(
          {
            ok: false,
            rateLimited: true,
            reason: "user_burst",
            retryAfterSec: burstPeek.retryAfterSec,
            error: `Too many refreshes — slow down and try again in ${fmtCountdown(burstPeek.retryAfterSec)}.`,
          },
          { status: 429, headers: { "Retry-After": String(burstPeek.retryAfterSec) } }
        );
      }
      rateLimit(USER_BURST_BUCKET, userKey, burstLimit, USER_BURST_WINDOW_MS);
    }

    const ts = await getValidToken(sim);
    if (ts.needsLogin || !ts.token) {
      return NextResponse.json({
        ok: false,
        needsLogin: true,
        error: "Token expired — re-login required",
      });
    }

    const knownSubId = sim.subscription_id || "";
    const [bal, prefetchedDetail] = await Promise.all([
      getBalance(ts.token, msisdn),
      knownSubId ? getAccountDetail(ts.token, knownSubId).catch(() => null) : Promise.resolve(null),
    ]);
    if (!bal) return NextResponse.json({ ok: false, error: "Could not fetch balance" });

    let subId = bal.subId || knownSubId;
    if (!subId) {
      const subs = await listSubscriptions(ts.token).catch(() => []);
      const mine = subs.find((s) => normalizeMsisdn(s.isdn) === msisdn) ?? subs[0];
      if (mine?.id) subId = mine.id;
    }

    const detail =
      subId && subId === knownSubId
        ? prefetchedDetail
        : subId
          ? await getAccountDetail(ts.token, subId).catch(() => null)
          : null;

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
      balanceCheckedAt: nowSec,
      subId,
      billExpireAt: detail?.billExpireAt ?? sim.bill_expire_at,
      blockOneWay: detail?.blockOneWay ?? sim.block_one_way,
      blockTwoWay: detail?.blockTwoWay ?? sim.block_two_way,
      simStatusText: detail?.currentStatus ?? sim.sim_status_text,
    });
  } catch (err: any) {
    console.error(`[sims/refresh] ${err?.message || err}`);
    return NextResponse.json(
      { ok: false, error: err?.message || "Failed to reach Mytel server" },
      { status: 502 }
    );
  } finally {
    if (acquiredLock && msisdn) {
      inFlight.delete(msisdn);
    }
  }
}
