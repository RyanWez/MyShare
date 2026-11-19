import { NextRequest, NextResponse } from "next/server";
import { authenticator } from "otplib";
import { dbApi } from "@/lib/db";
import { parseTransfersFilter } from "@/lib/historyFilter";
import { canAccessSim, requireSession, resolveScopedRexId } from "@/lib/authz";
import { verifyPasswordHash } from "@/lib/password";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.history.view);
  if (!auth.ok) return auth.response;

  const { fromTs, toTs, status, q, page, pageSize } = parseTransfersFilter(req);
  const rexId = resolveScopedRexId(auth.user, req.nextUrl.searchParams.get("rexId"));

  const { rows, total } = await dbApi.listTransfersFiltered(
    { fromTs, toTs, status, q: q || undefined, rexId },
    pageSize,
    (page - 1) * pageSize
  );

  return NextResponse.json({
    ok: true,
    transfers: rows,
    total,
    page,
    pageSize,
  });
}

export async function DELETE(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.history.delete);
  if (!auth.ok) return auth.response;

  try {
    const { id, password, totpCode } = await req.json();
    if (typeof id !== "number") {
      return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
    }

    const transfer = await dbApi.getTransferById(id);
    if (!transfer) {
      return NextResponse.json({ ok: false, error: "Transfer not found" }, { status: 404 });
    }
    if (!canAccessSim(auth.user, { rex_id: transfer.rex_id })) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }

    if (transfer.amount >= 5000) {
      const totpSecret = process.env.AUTH_TOTP_SECRET;
      if (totpSecret) {
        if (!totpCode || !authenticator.check(totpCode, totpSecret)) {
          return NextResponse.json(
            { ok: false, error: "Unauthorized: Incorrect Google Auth Code" },
            { status: 401 }
          );
        }
      } else {
        if (!password || !verifyPasswordHash(password, auth.user.password_hash)) {
          return NextResponse.json(
            { ok: false, error: "Unauthorized: Incorrect password for large amount" },
            { status: 401 }
          );
        }
      }
    }

    await dbApi.deleteTransfer(id);
    await dbApi.addAuditLog({
      actorUserId: auth.user.id,
      actorUsername: auth.user.username,
      action: "history.delete",
      targetType: "transfer",
      targetId: String(id),
      detail: {
        sender: transfer.sender_phone,
        receiver: transfer.receiver_phone,
        amount: transfer.amount,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
