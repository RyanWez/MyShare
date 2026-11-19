import { NextRequest, NextResponse } from "next/server";
import { dbApi } from "@/lib/db";
import { requireSession, resolveScopedRexId } from "@/lib/authz";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.receivers.view);
  if (!auth.ok) return auth.response;

  const params = req.nextUrl.searchParams;
  const parseTs = (name: string): number | undefined => {
    const raw = Number(params.get(name));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
  };

  const sender = params.get("sender")?.trim() || undefined;
  const rexId = resolveScopedRexId(auth.user, params.get("rexId"));

  const { groups, senders, transferCount } = await dbApi.receiversInRange(
    parseTs("from"),
    parseTs("to"),
    sender,
    rexId
  );

  return NextResponse.json({ ok: true, groups, senders, transferCount });
}
