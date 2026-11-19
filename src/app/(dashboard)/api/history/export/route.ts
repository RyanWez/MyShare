import type { NextRequest } from "next/server";
import { dbApi } from "@/lib/db";
import { parseTransfersFilter } from "@/lib/historyFilter";
import { requireSession, resolveScopedRexId } from "@/lib/authz";

export const dynamic = "force-dynamic";

const EXPORT_CAP = 100_000;
const EXPORT_BATCH_SIZE = 2_000;

const csvCell = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const CSV_HEADER = [
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
].join(",");

export async function GET(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.history.view && p.history.export);
  if (!auth.ok) return auth.response;

  const { fromTs, toTs, status, q } = parseTransfersFilter(req);
  const rexId = resolveScopedRexId(auth.user, req.nextUrl.searchParams.get("rexId"));
  const filter = { fromTs, toTs, status, q: q || undefined, rexId };
  const stamp = new Date().toISOString().slice(0, 10);
  const enc = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(enc.encode("\uFEFF" + CSV_HEADER));
        let cursor: { createdAt: number; id: number } | null = null;
        let exported = 0;

        while (exported < EXPORT_CAP && !req.signal.aborted) {
          const take = Math.min(EXPORT_BATCH_SIZE, EXPORT_CAP - exported);
          const rows = await dbApi.listTransfersExportBatch(filter, cursor, take);
          if (rows.length === 0) break;

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

          controller.enqueue(enc.encode("\r\n" + lines.join("\r\n")));
          exported += rows.length;
          const last = rows[rows.length - 1];
          cursor = { createdAt: last.created_at, id: last.id };
          if (rows.length < take) break;
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="myshare-history-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
