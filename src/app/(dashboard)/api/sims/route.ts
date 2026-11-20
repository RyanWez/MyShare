import { NextRequest, NextResponse } from "next/server";
import { dbApi } from "@/lib/db";
import { normalizeMsisdn } from "@/lib/mytel";
import { requireSession, resolveScopedRexId } from "@/lib/authz";
import type { TransferBalanceFilter } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.sims.view || p.transfer.view);
  if (!auth.ok) return auth.response;

  const q = req.nextUrl.searchParams;
  const rexId = resolveScopedRexId(auth.user, q.get("rexId"));
  const pageRaw = q.get("page");

  // Paged mode (used by SIM Tray for 5,000+ SIM scale)
  if (pageRaw !== null) {
    const page = Math.max(1, Number(pageRaw) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(q.get("pageSize")) || 24));
    const viewParam = q.get("view");
    const view =
      viewParam === "active" ||
      viewParam === "inactive" ||
      viewParam === "drained" ||
      viewParam === "expiring" ||
      viewParam === "expired"
        ? viewParam
        : "all";
    const sortParam = q.get("sort");
    const sort =
      sortParam === "balance-asc" || sortParam === "balance-desc" || sortParam === "expiry-asc"
        ? sortParam
        : "recent";
    const search = q.get("q") ?? "";

    const paged = await dbApi.listSimsPaged({
      rexId,
      view,
      q: search,
      sort,
      page,
      pageSize,
    });
    return NextResponse.json({
      ok: true,
      sims: paged.sims,
      total: paged.total,
      counts: paged.counts,
    });
  }

  // Unpaged mode (used by Transfer sender picker, active-first with optional search & limit)
  const statusFilter = q.get("status") || undefined;
  const bfParam = q.get("balanceFilter");
  const balanceFilter: TransferBalanceFilter =
    bfParam === "ready" || bfParam === "low" ? bfParam : "all";
  const searchQuery = q.get("q")?.trim() || undefined;
  const rawLimit = Number(q.get("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(2000, Math.floor(rawLimit)) : 48;
  const includePhoneRaw = !searchQuery ? q.get("includePhone")?.trim() : undefined;
  const includePhone = includePhoneRaw ? normalizeMsisdn(includePhoneRaw) : undefined;

  const { sims, total, activeTotal, counts } = await dbApi.listSimsPublic({
    rexId,
    status: statusFilter,
    balanceFilter,
    q: searchQuery,
    includePhone,
    limit,
  });
  return NextResponse.json({ ok: true, sims, total, activeTotal, counts });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.sims.moveRex && p.rex.viewAll);
  if (!auth.ok) return auth.response;

  const { phones, rexId } = await req.json();
  if (!Array.isArray(phones) || phones.length === 0) {
    return NextResponse.json({ ok: false, error: "phones required" }, { status: 400 });
  }

  let targetRexId: number | null = null;
  if (rexId !== null && rexId !== undefined && rexId !== "") {
    const parsed = Number(rexId);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return NextResponse.json({ ok: false, error: "Invalid rexId" }, { status: 400 });
    }
    const group = await dbApi.getRexGroupById(parsed);
    if (!group) {
      return NextResponse.json({ ok: false, error: "Rex group not found" }, { status: 404 });
    }
    targetRexId = parsed;
  }

  const normalized = phones.map((p: string) => normalizeMsisdn(p));
  const moved = await dbApi.moveSimsToRex(normalized, targetRexId);

  await dbApi.addAuditLog({
    actorUserId: auth.user.id,
    actorUsername: auth.user.username,
    action: "sims.move_rex",
    targetType: "sims",
    detail: { count: moved, targetRexId, phones: normalized.slice(0, 20) },
  });

  return NextResponse.json({ ok: true, moved });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.sims.delete);
  if (!auth.ok) return auth.response;

  const { phone, phones } = await req.json();
  const targets: string[] = [];
  if (phone) targets.push(phone);
  if (Array.isArray(phones)) targets.push(...phones);

  if (targets.length === 0)
    return NextResponse.json({ ok: false, error: "phone or phones required" }, { status: 400 });

  const normalized = targets.map((p) => normalizeMsisdn(p));
  const scopedRexId = auth.user.permissions.rex.viewAll ? null : (auth.user.rex_id ?? -1);
  const removed = await dbApi.deleteSims(normalized, scopedRexId);

  if (removed > 0) {
    await dbApi.addAuditLog({
      actorUserId: auth.user.id,
      actorUsername: auth.user.username,
      action: "sims.delete",
      targetType: "sims",
      detail: { count: removed, phones: normalized.slice(0, 20) },
    });
  }

  return NextResponse.json({ ok: true, removed });
}
