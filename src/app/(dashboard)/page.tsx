"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, SquareStack } from "lucide-react";
import { Eyebrow } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorBanner, ErrorState } from "@/components/ui/ErrorState";
import { StatusDot } from "@/components/ui/StatusDot";
import { Button } from "@/components/ui/Button";
import { MetricStrip, type Metric } from "@/components/MetricStrip";
import { TrendChart } from "@/components/TrendChart";
import { RangePicker } from "@/components/RangePicker";
import { CountUp } from "@/components/CountUp";
import { useSession } from "@/components/SessionProvider";
import { firstAllowedRoute } from "@/lib/permissions";
import {
  fmtAmount,
  fmtClock,
  fmtDayHeader,
  fmtPhoneGrouped,
  fmtShortDate,
  statusBadge,
} from "@/lib/format";
import { ErrorPieChart } from "@/components/ErrorPieChart";
import { CHART_INK, presetRange, type RangeKey } from "@/lib/chart";
import { DAILY_VOLUME_LIMIT, MONTHLY_VOLUME_LIMIT } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { ApiError, fetchStats, invalidateCache } from "@/lib/api";
import { useLive } from "@/lib/liveEvents";
import type { StatsResponse } from "@/lib/types";

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * First-paint placeholder mirroring the page's real layout, so the dashboard
 * never greets the operator with blank "—" slots. Only used before the very
 * first fetch lands — refetches hold the previous render instead (deliberate
 * stale-while-revalidate, no flicker on every SSE push).
 */
function DashboardSkeleton() {
  return (
    <div className="mx-auto max-w-5xl space-y-8 animate-pulse" aria-busy="true" aria-label="Loading dashboard">
      {/* Hero figure */}
      <div className="space-y-3">
        <div className="h-2.5 w-24 rounded bg-substrate" />
        <div className="h-11 w-72 max-w-full rounded bg-substrate" />
        <div className="h-3 w-52 rounded bg-substrate" />
      </div>

      <div className="space-y-4">
        {/* Range presets */}
        <div className="h-10 w-full max-w-md rounded border border-hairline bg-card" />

        {/* Metric strip */}
        <div className="grid gap-px overflow-hidden rounded border border-hairline bg-hairline sm:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="space-y-2 bg-card px-4 py-3.5">
              <div className="h-2.5 w-20 rounded bg-substrate" />
              <div className="h-5 w-28 rounded bg-substrate" />
              <div className="h-2.5 w-24 rounded bg-substrate" />
            </div>
          ))}
        </div>

        {/* Two chart cards */}
        <div className="grid gap-4 lg:grid-cols-2">
          {[1, 2].map((i) => (
            <div key={i} className="rounded-lg border border-hairline bg-card px-4 py-4 shadow-panel">
              <div className="mb-4 h-2.5 w-28 rounded bg-substrate" />
              <div className="h-40 rounded bg-substrate/70" />
            </div>
          ))}
        </div>
      </div>

      {/* Recent list */}
      <div className="divide-y divide-hairline overflow-hidden rounded border border-hairline bg-card">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3.5">
            <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-substrate" />
            <div className="h-3 w-10 shrink-0 rounded bg-substrate" />
            <div className="h-3 w-48 max-w-[60%] flex-1 rounded bg-substrate" />
            <div className="ml-auto h-3.5 w-16 shrink-0 rounded bg-substrate" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const { user, loading: sessionLoading, permissions, rexFilter } = useSession();
  const ov = permissions.overview;

  const [preset, setPreset] = useState<RangeKey>("today");
  const [range, setRange] = useState(() => presetRange("today"));
  const [data, setData] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionLoading && user && !ov.view) {
      const dest = firstAllowedRoute(permissions);
      if (dest !== "/") router.replace(dest);
    }
  }, [sessionLoading, user, ov.view, permissions, router]);

  const rangeRef = useRef(range);
  const rexRef = useRef(rexFilter);
  useEffect(() => {
    rangeRef.current = range;
    rexRef.current = rexFilter;
  }, [range, rexFilter]);

  const reload = useCallback((background = false) => {
    if (!ov.view) return Promise.resolve();
    if (!background) setLoading(true);
    const opts = background
      ? { bypassCache: true, noDelay: true, rexId: rexRef.current }
      : { noDelay: true, rexId: rexRef.current };
    const r = rangeRef.current;
    return fetchStats(r.from, r.to, opts)
      .then((d: StatsResponse) => {
        if (d?.ok) {
          setData(d);
          setError(null);
        }
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.userMessage : "Something went wrong reading this.");
      })
      .finally(() => {
        setLoading(false);
        setLoaded(true);
      });
  }, [ov.view]);

  useEffect(() => {
    if (sessionLoading || !ov.view) return;
    let alive = true;

    setLoading(true);
    fetchStats(range.from, range.to, { rexId: rexFilter, noDelay: true })
      .then((d: StatsResponse) => {
        if (!alive) return;
        if (d?.ok) {
          setData(d);
          setError(null);
        }
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof ApiError ? err.userMessage : "Something went wrong reading this.");
      })
      .finally(() => {
        if (!alive) return;
        setLoading(false);
        setLoaded(true);
      });

    return () => {
      alive = false;
    };
  }, [range, rexFilter, sessionLoading, ov.view]);

  // One shared EventSource app-wide — pushes land here while the tab is open.
  // Connection health shows as the LED in the sidebar footer.
  useLive(() => {
    invalidateCache();
    reload(true);
  });

  const onPreset = useCallback((key: RangeKey) => {
    setPreset(key);
    if (key !== "custom") setRange(presetRange(key));
  }, []);

  const onRangeChange = useCallback((from: number, to: number) => {
    setRange({ from, to });
  }, []);

  // Mirrors the server's rule so the axis caption is right on the first paint instead
  // of flipping from "day" to "hour" when the fetch lands.
  const hourly = data
    ? data.series.granularity === "hour"
    : (range.to - range.from) / 86400 <= 1.001;
  const buckets = useMemo(() => data?.series.buckets ?? [], [data?.series.buckets]);

  const axis = useMemo(() => {
    const ticks: string[] = [];
    const long: string[] = [];
    for (const b of buckets) {
      const d = new Date(b.ts * 1000);
      if (hourly) {
        ticks.push(pad2(d.getHours()));
        long.push(`${pad2(d.getHours())}:00`);
      } else {
        ticks.push(fmtShortDate(b.ts));
        long.push(fmtDayHeader(b.ts));
      }
    }
    return { ticks, long };
  }, [buckets, hourly]);

  const countSeries = useMemo(
    () => [
      { key: "sent", label: "Sent", color: CHART_INK.sent, values: buckets.map((b) => b.sent) },
      {
        key: "failed",
        label: "Failed",
        color: CHART_INK.failed,
        values: buckets.map((b) => b.failed),
      },
    ],
    [buckets]
  );

  const volumeSeries = useMemo(
    () => [
      {
        key: "volume",
        label: "Volume",
        color: CHART_INK.volume,
        values: buckets.map((b) => b.volume),
      },
    ],
    [buckets]
  );

  const stats = data?.stats;
  const totals = data?.totals;
  // The charts and the tiles describe the same slice, so one phrase names it for both.
  const period =
    preset === "today"
      ? "today"
      : `${fmtShortDate(range.from)} – ${fmtShortDate(range.to - 1)}`;
  const grain = hourly ? "Hour by hour" : "Day by day";

  // Very first visit: show the layout taking shape rather than "—" placeholders.
  if (sessionLoading || (!loaded && !data) || !ov.view) {
    return <DashboardSkeleton />;
  }

  // Nothing read at all: an unreachable server used to render as "—" and
  // "Reading the tray…" forever, indistinguishable from a slow load.
  if (error && !data) {
    return (
      <div className="mx-auto max-w-5xl pt-6">
        <ErrorState
          what="the dashboard"
          detail={error}
          onRetry={() => reload(true)}
          retrying={loading}
        />
      </div>
    );
  }

  if (loaded && stats && stats.simCount === 0) {
    return (
      <EmptyState
        icon={<SquareStack className="h-7 w-7" strokeWidth={1.25} />}
        title="The tray is empty"
        body={
          permissions.sims.addLogin
            ? "Log in a Mytel SIM to read its balance and start sending transfers."
            : "No SIMs are assigned to this group yet. Ask your Admin to add or assign SIMs."
        }
        action={
          permissions.sims.addLogin ? (
            <Button asChild>
              <Link href="/sims">
                Log in a SIM
                <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
              </Link>
            </Button>
          ) : undefined
        }
      />
    );
  }

  const metricItems: Metric[] = [];
  if (ov.successMetric) {
    metricItems.push({
      label: `Success ${period}`,
      value: totals?.sent ?? 0,
      format: fmtAmount,
      sub: totals
        ? `${Math.round((totals.sent / Math.max(1, totals.sent + totals.failed)) * 100)}% success rate`
        : undefined,
    });
  }
  if (ov.volumeMetric) {
    metricItems.push({
      label: `Volume ${period}`,
      value: totals?.volume ?? 0,
      format: fmtAmount,
      sub: "Ks, fees excluded",
      tone: totals?.volume ? "brass" : "muted",
    });
  }
  if (ov.netVolumeMetric) {
    metricItems.push({
      label: `Volume (-20%) ${period}`,
      value: Math.round((totals?.volume ?? 0) * 0.8),
      format: fmtAmount,
      sub: "Ks, 20% deducted",
      tone: totals?.volume ? "brass" : "muted",
    });
  }

  const showChartGrid = ov.transfersChart || ov.volumeChart;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {error && data && (
        <ErrorBanner
          what="the dashboard"
          detail={error}
          onRetry={() => reload(true)}
          retrying={loading}
        />
      )}

      {ov.totalBalance && stats && stats.totalBalance !== null && (
        <section className="animate-rise-spring">
          <Eyebrow>Total available</Eyebrow>
          <div className="mt-2 font-mono text-hero tnum text-brass-deep">
            <CountUp value={stats.totalBalance} format={fmtAmount} />
            <span className="ml-2 align-baseline text-lg font-normal tracking-normal text-ink-mute">
              Ks
            </span>
          </div>
          <p className="mt-1.5 text-sm text-ink-mute">
            across {stats.loggedIn} active {stats.loggedIn === 1 ? "SIM" : "SIMs"} of{" "}
            {stats.simCount} in the tray
          </p>
        </section>
      )}

      {(metricItems.length > 0 || showChartGrid || ov.topErrorsChart) && (
        <section className="space-y-4">
          <div className="animate-rise-spring relative z-20 [animation-delay:60ms]">
            <RangePicker
              preset={preset}
              onPresetChange={onPreset}
              from={range.from}
              to={range.to}
              onRangeChange={onRangeChange}
            />
          </div>

          <div className={cn("space-y-6 transition-opacity", loading && data && "opacity-50")}>
            {metricItems.length > 0 && (
              <div className="animate-rise-spring [animation-delay:110ms]">
                <MetricStrip stagger items={metricItems} />
              </div>
            )}

            {showChartGrid && (
              <div
                className={cn(
                  "grid gap-4",
                  ov.transfersChart && ov.volumeChart ? "lg:grid-cols-2" : "grid-cols-1"
                )}
              >
                {ov.transfersChart && (
                  <div className="animate-rise-spring [animation-delay:170ms] rounded-lg border border-hairline bg-card px-4 py-4 shadow-panel">
                    <div className="mb-1 flex items-baseline justify-between gap-4">
                      <Eyebrow>Transfers</Eyebrow>
                      <span className="font-mono text-eyebrow uppercase text-ink-faint">
                        {grain}
                      </span>
                    </div>
                    <TrendChart
                      labels={axis.ticks}
                      longLabels={axis.long}
                      series={countSeries}
                      height={196}
                      replayKey={`${range.from}-${range.to}-count`}
                      caption={`Transfers ${period}, ${grain.toLowerCase()}`}
                    />
                  </div>
                )}

                {ov.volumeChart && (
                  <div className="animate-rise-spring [animation-delay:230ms] rounded-lg border border-hairline bg-card px-4 py-4 shadow-panel">
                    <div className="mb-1 flex items-baseline justify-between gap-4">
                      <Eyebrow>Volume moved</Eyebrow>
                      <span className="font-mono text-eyebrow uppercase text-ink-faint">Ks</span>
                    </div>
                    <TrendChart
                      labels={axis.ticks}
                      longLabels={axis.long}
                      series={volumeSeries}
                      height={196}
                      replayKey={`${range.from}-${range.to}-volume`}
                      caption={`Volume moved ${period} in Ks, ${grain.toLowerCase()}`}
                    />
                  </div>
                )}
              </div>
            )}

            {ov.topErrorsChart && data?.topErrors && data.topErrors.length > 0 && (
              <div className="animate-rise-spring [animation-delay:290ms] rounded-lg border border-hairline bg-card px-4 py-4 shadow-panel">
                <div className="mb-4 flex items-baseline justify-between gap-4">
                  <Eyebrow>Top Error Reasons</Eyebrow>
                  <span className="font-mono text-eyebrow uppercase text-ink-faint">
                    {fmtAmount(totals?.failed ?? 0)} FAILED
                  </span>
                </div>
                <ErrorPieChart data={data.topErrors} className="py-2" />
              </div>
            )}
          </div>
        </section>
      )}

      {ov.recentList && (
        <section>
          <div className="animate-rise-spring [animation-delay:320ms] mb-3 flex items-baseline justify-between gap-4">
            <Eyebrow>Recent</Eyebrow>
            {permissions.history.view && (
              <Link
                href="/history"
                className="font-mono text-eyebrow font-semibold uppercase text-ink-mute underline-offset-4 transition-colors hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2"
              >
                Full history
              </Link>
            )}
          </div>

          <div className="animate-rise-spring [animation-delay:350ms] overflow-hidden rounded-lg border border-hairline bg-card shadow-panel">
            {stats?.recent.length ? (
              <ul className="divide-y divide-hairline">
                {stats.recent.map((t, i) => {
                  const badge = statusBadge(t.status);
                  return (
                    <li
                      key={t.id}
                      style={{ animationDelay: `${380 + Math.min(i, 8) * 40}ms` }}
                      className="animate-rise-spring flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 transition-colors hover:bg-substrate"
                    >
                      <StatusDot tone={badge.tone} size="sm" />
                      <span className="shrink-0 font-mono text-xs tnum text-ink-mute">
                        {fmtClock(t.created_at)}
                      </span>
                      <span className="order-3 flex min-w-0 flex-1 basis-full items-center gap-2 font-mono text-xs tnum text-ink-soft sm:order-none sm:basis-auto">
                        <span className="truncate">{fmtPhoneGrouped(t.sender_phone)}</span>
                        <ArrowRight
                          className="h-3 w-3 shrink-0 text-brass"
                          strokeWidth={2}
                          aria-hidden="true"
                        />
                        <span className="truncate">{fmtPhoneGrouped(t.receiver_phone)}</span>
                      </span>
                      <span className="order-2 ml-auto shrink-0 font-mono text-sm tnum text-brass-deep sm:order-none">
                        {fmtAmount(t.amount)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <EmptyState
                title="No transfers yet"
                body="Pick a SIM, enter a receiver and amount, and confirm with the OTP sent to the sender."
                action={
                  permissions.transfer.execute ? (
                    <Button asChild size="sm" variant="secondary">
                      <Link href="/transfer">Start a transfer</Link>
                    </Button>
                  ) : undefined
                }
                className="py-12"
              />
            )}
          </div>
        </section>
      )}

      <p className="max-w-xl text-xs leading-relaxed text-ink-faint">
        MyShare limits: 500–5,000 Ks per transfer, 5% fee, {fmtAmount(DAILY_VOLUME_LIMIT)} Ks daily and {fmtAmount(MONTHLY_VOLUME_LIMIT)} Ks monthly per SIM.
        The OTP always goes to the sender SIM.
      </p>
    </div>
  );
}
