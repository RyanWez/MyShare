import type { NextRequest } from "next/server";
import { dbApi } from "@/lib/db";
import { parseTransfersFilter } from "@/lib/historyFilter";
import { requireSession, resolveScopedRexId } from "@/lib/authz";

export const dynamic = "force-dynamic";

const EXPORT_CAP = 100_000;

const csvCell = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function GET(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.history.view && p.history.export);
  if (!auth.ok) return auth.response;

  const { fromTs, toTs, status, q } = parseTransfersFilter(req);
  const rexId = resolveScopedRexId(auth.user, req.nextUrl.searchParams.get("rexId"));

  const { rows } = await dbApi.listTransfersFiltered(
    { fromTs, toTs, status, q: q || undefined, rexId },
    EXPORT_CAP,
    0
  );

  const header = [
    "id",
    "datetime",
    "rex",
    "operator",
    "sender",
    "receiver",
    "amount",
    "fee",
    "status",
    "error_code",
    "message",
  ];
  const lines = rows.map((r) =>
    [
      r.id,
      new Date(r.created_at * 1000).toISOString(),
      r.rex_name ?? "",
      r.created_by_username ?? "",
      r.sender_phone,
      r.receiver_phone,
      r.amount,
      r.fee,
      r.status,
      r.error_code ?? "",
      r.message ?? "",
    ]
      .map(csvCell)
      .join(",")
  );

  const csv = "\uFEFF" + [header.join(","), ...lines].join("\r\n");
  const stamp = new Date().toISOString().slice(0, 10);

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="myshare-history-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
