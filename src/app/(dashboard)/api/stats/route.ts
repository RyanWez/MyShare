import { NextRequest, NextResponse } from "next/server";
import { dbApi, type Granularity, type SeriesBucket } from "@/lib/db";
import { requireSession, resolveScopedRexId } from "@/lib/authz";

export const dynamic = "force-dynamic";

function resolveRange(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const fromRaw = Number(q.get("from"));
  const toRaw = Number(q.get("to"));

  if (Number.isFinite(fromRaw) && Number.isFinite(toRaw) && fromRaw > 0 && toRaw > fromRaw) {
    const spanDays = (toRaw - fromRaw) / 86400;
    const granularity: Granularity = spanDays <= 1.001 ? "hour" : "day";
    return { from: Math.floor(fromRaw), to: Math.floor(toRaw), granularity };
  }

  const mmOffsetMs = 6.5 * 3600 * 1000;
  const shiftedNow = new Date(Date.now() + mmOffsetMs);
  const startUtcMs = Date.UTC(
    shiftedNow.getUTCFullYear(),
    shiftedNow.getUTCMonth(),
    shiftedNow.getUTCDate()
  );
  const from = Math.floor(startUtcMs / 1000) - 23400;
  return {
    from,
    to: from + 86400,
    granularity: "hour" as Granularity,
  };
}

function totals(buckets: SeriesBucket[]) {
  return buckets.reduce(
    (acc, b) => ({
      sent: acc.sent + b.sent,
      failed: acc.failed + b.failed,
      volume: acc.volume + b.volume,
    }),
    { sent: 0, failed: 0, volume: 0 }
  );
}

export async function GET(req: NextRequest) {
  const auth = await requireSession(req, (p) => p.overview.view);
  if (!auth.ok) return auth.response;

  const ov = auth.user.permissions.overview;
  const rexId = resolveScopedRexId(auth.user, req.nextUrl.searchParams.get("rexId"));
  const { from, to, granularity } = resolveRange(req);

  const [buckets, tray, topErrors] = await Promise.all([
    dbApi.rangeSeries(from, to, granularity, rexId),
    dbApi.trayStats(rexId),
    ov.topErrorsChart ? dbApi.topErrors(from, to, rexId) : Promise.resolve([]),
  ]);

  const sum = totals(buckets);

  // Strip disallowed widgets server-side so restricted fields never leak over the wire.
  const sanitizedBuckets: SeriesBucket[] =
    ov.transfersChart || ov.volumeChart
      ? buckets.map((b) => ({
          ts: b.ts,
          sent: ov.transfersChart ? b.sent : 0,
          failed: ov.transfersChart ? b.failed : 0,
          volume: ov.volumeChart ? b.volume : 0,
        }))
      : [];

  return NextResponse.json({
    ok: true,
    stats: {
      simCount: tray.simCount,
      loggedIn: tray.loggedIn,
      totalBalance: ov.totalBalance ? tray.totalBalance : null,
      recent: ov.recentList ? tray.recent : [],
    },
    series: { from, to, granularity, buckets: sanitizedBuckets },
    totals: {
      sent: ov.successMetric ? sum.sent : 0,
      failed: ov.successMetric || ov.topErrorsChart ? sum.failed : 0,
      volume: ov.volumeMetric || ov.netVolumeMetric ? sum.volume : 0,
    },
    topErrors,
  });
}
