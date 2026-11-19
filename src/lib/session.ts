import {
  listSubscriptions,
  getBalance,
  getAccountDetail,
  normalizeMsisdn,
  type LoginResult,
} from "@/lib/mytel";
import { dbApi } from "@/lib/db";

/**
 * Store a fresh token pair for a SIM and best-effort read its subscription id,
 * balance, and bill/SIM expiry metadata.
 */
export async function persistLogin(
  msisdn: string,
  lr: LoginResult,
  subscriptionIdHint?: string | null,
  owner?: { rexId?: number | null; addedByUserId?: number | null }
): Promise<{ subscriptionId: string | null; balance: number | null }> {
  const nowSec = Math.floor(Date.now() / 1000);

  let subscriptionId: string | null = subscriptionIdHint ?? null;
  let balance: number | null = null;
  let billExpireAt: string | null | undefined = undefined;
  let blockOneWay: string | null | undefined = undefined;
  let blockTwoWay: string | null | undefined = undefined;
  let simStatusText: string | null | undefined = undefined;

  try {
    if (subscriptionId) {
      const bal = await getBalance(lr.access_token, msisdn);
      if (bal) balance = bal.mainAmount;
    } else {
      const subs = await listSubscriptions(lr.access_token);
      const mine = subs.find((s) => normalizeMsisdn(s.isdn) === msisdn) ?? subs[0];
      if (mine) {
        subscriptionId = mine.id;
        const bal = await getBalance(lr.access_token, normalizeMsisdn(mine.isdn));
        if (bal) balance = bal.mainAmount;
      }
    }
    if (subscriptionId) {
      const detail = await getAccountDetail(lr.access_token, subscriptionId).catch(() => null);
      if (detail) {
        billExpireAt = detail.billExpireAt;
        blockOneWay = detail.blockOneWay;
        blockTwoWay = detail.blockTwoWay;
        simStatusText = detail.currentStatus;
      }
    }
  } catch {
    // non-fatal: balance & expiry can be refreshed later
  }

  const existing = await dbApi.getSim(msisdn);
  const assignRex =
    !existing || (existing.rex_id === null && owner?.rexId !== undefined && owner.rexId !== null);

  await dbApi.upsertSim(msisdn, {
    access_token: lr.access_token,
    refresh_token: lr.refresh_token,
    token_expires_at: nowSec + (lr.expires_in ?? 300),
    refresh_expires_at: nowSec + (lr.refresh_expires_in ?? 0),
    subscription_id: subscriptionId,
    balance,
    balance_checked_at: balance !== null ? nowSec : null,
    ...(billExpireAt !== undefined ? { bill_expire_at: billExpireAt } : {}),
    ...(blockOneWay !== undefined ? { block_one_way: blockOneWay } : {}),
    ...(blockTwoWay !== undefined ? { block_two_way: blockTwoWay } : {}),
    ...(simStatusText !== undefined ? { sim_status_text: simStatusText } : {}),
    ...(assignRex ? { rex_id: owner?.rexId ?? null } : {}),
    ...(!existing ? { added_by_user_id: owner?.addedByUserId ?? null } : {}),
    status: "active",
  });

  return { subscriptionId, balance };
}
