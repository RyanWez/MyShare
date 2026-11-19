import { NextRequest, NextResponse } from "next/server";
import { dbApi } from "@/lib/db";
import { requireSession, resolveScopedRexId } from "@/lib/authz";

export const dynamic = "force-dynamic";

/** Lightweight SIM fleet count for Sidebar status footer (zero chart/transfer queries). */
export async function GET(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.overview.view || p.sims.view || p.transfer.view);
  if (!auth.ok) return auth.response;

  const rexId = resolveScopedRexId(auth.user, req.nextUrl.searchParams.get("rexId"));
  const counts = await dbApi.fleetCounts(rexId);
  return NextResponse.json({ ok: true, ...counts });
}
