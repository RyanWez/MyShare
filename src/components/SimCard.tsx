"use client";

import * as React from "react";
import { RefreshCw, Trash2, LogIn, Cpu, Check, CheckCircle2, CalendarClock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Panel } from "@/components/ui/Panel";
import { StatusDot } from "@/components/ui/StatusDot";
import { Button } from "@/components/ui/Button";
import { TokenLife } from "@/components/TokenLife";
import { useCooldownActive } from "@/components/Cooldown";
import { fmtAmount, fmtPhoneGrouped, fmtTime, statusBadge } from "@/lib/format";
import { DAILY_VOLUME_LIMIT, MONTHLY_VOLUME_LIMIT, SIM_REFRESH_COOLDOWN_SEC } from "@/lib/constants";
import type { Sim } from "@/lib/types";

export interface SimCardProps {
  sim: Sim;
  onRefresh?: (sim: Sim) => void;
  onRemove?: (sim: Sim) => void;
  onLogin?: (sim: Sim) => void;
  refreshing?: boolean;
  canRefresh?: boolean;
  canBypassRefreshLimit?: boolean;
  canDelete?: boolean;
  canLogin?: boolean;
  showRex?: boolean;
  className?: string;
  style?: React.CSSProperties;
  selected?: boolean;
  selectionMode?: boolean;
  onSelectToggle?: (sim: Sim) => void;
}

const MM_OFFSET_MS = (6 * 60 + 30) * 60 * 1000;

function yangonDayNumber(ms: number): number {
  return Math.floor((ms + MM_OFFSET_MS) / 86_400_000);
}

function classifyExpiry(raw: string | null | undefined): {
  label: string;
  tone: "normal" | "warn" | "alert";
} | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Handle epoch ms/sec or DD/MM/YYYY, DD-MM-YYYY, ISO date strings gracefully
  let ms = Number.NaN;
  if (/^\d{10,13}$/.test(trimmed)) {
    const n = Number(trimmed);
    ms = trimmed.length === 13 ? n : n * 1000;
  } else {
    const dmy = trimmed.match(/^(\d{2})[/-](\d{2})[/-](\d{4})/);
    if (dmy) {
      ms = Date.parse(`${dmy[3]}-${dmy[2]}-${dmy[1]}T00:00:00+06:30`);
    } else {
      const ymd = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
      ms = ymd ? Date.parse(`${ymd[1]}-${ymd[2]}-${ymd[3]}T00:00:00+06:30`) : Date.parse(trimmed);
    }
  }

  if (!Number.isFinite(ms)) {
    return { label: trimmed, tone: "normal" };
  }

  // Exact calendar-day diff in Asia/Yangon — matches server-side PostgreSQL filter.
  const daysLeft = yangonDayNumber(ms) - yangonDayNumber(Date.now());
  const formatted = new Date(ms).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Yangon",
  });

  if (daysLeft <= 0) return { label: `Expired (${formatted})`, tone: "alert" };
  if (daysLeft <= 10) return { label: `Exp ${formatted} (${daysLeft}d)`, tone: "warn" };
  return { label: `Exp ${formatted}`, tone: "normal" };
}

const SimCard = React.memo(function SimCard({
  sim,
  onRefresh,
  onRemove,
  onLogin,
  refreshing,
  canRefresh = true,
  canBypassRefreshLimit = false,
  canDelete = true,
  canLogin = true,
  showRex = false,
  className,
  style,
  selected,
  selectionMode,
  onSelectToggle,
}: SimCardProps) {
  const state = statusBadge(sim.status);
  const active = sim.status === "active";
  const atLimit = sim.volume_today >= DAILY_VOLUME_LIMIT || sim.volume_this_month >= MONTHLY_VOLUME_LIMIT;
  const expiry = classifyExpiry(sim.bill_expire_at);
  const cooldownUntil =
    !canBypassRefreshLimit &&
    active &&
    sim.balance !== null &&
    sim.balance_checked_at !== null
      ? sim.balance_checked_at + SIM_REFRESH_COOLDOWN_SEC
      : 0;
  const refreshCooldownActive = useCooldownActive(cooldownUntil);

  const blockTitleParts = [
    sim.sim_status_text ? `Status: ${sim.sim_status_text}` : null,
    sim.block_one_way ? `1-way block: ${sim.block_one_way}` : null,
    sim.block_two_way ? `2-way block: ${sim.block_two_way}` : null,
  ].filter(Boolean);

  return (
    <Panel
      as={selectionMode ? "button" : "div"}
      onClick={selectionMode ? () => onSelectToggle?.(sim) : undefined}
      active={selected}
      className={cn("group transition-all duration-300 ease-out hover:-translate-y-1 hover:shadow-lg", className)}
      style={style}
      contentClassName="relative flex h-full flex-col p-4 sm:p-5 bg-gradient-to-br from-card to-substrate overflow-hidden"
    >
      <div className={cn("absolute right-4 top-14 transition-opacity duration-300 pointer-events-none", selected ? "opacity-100" : "opacity-20 group-hover:opacity-40")}>
        {selected ? (
          <CheckCircle2 className="h-10 w-10 text-brass" strokeWidth={2} />
        ) : (
          <Cpu className="h-10 w-10 text-brass-deep" strokeWidth={1} />
        )}
      </div>

      <div className="relative z-10 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 min-w-0">
          <StatusDot tone={state.tone} pulse={active} />
          <span className="font-mono text-eyebrow font-semibold uppercase text-ink-soft">
            {state.label}
          </span>
          {showRex && sim.rex_name && (
            <span className="truncate rounded border border-hairline bg-substrate/80 px-1.5 py-0.5 font-mono text-[9.5px] uppercase text-ink-mute">
              {sim.rex_name}
            </span>
          )}
        </span>
        <span
          className={cn(
            "shrink-0 font-mono text-[10.5px] uppercase tnum",
            atLimit ? "text-alert-deep" : "text-ink-faint"
          )}
        >
          {fmtAmount(sim.volume_today)} / {fmtAmount(DAILY_VOLUME_LIMIT)}
        </span>
      </div>

      <div className="mt-3 font-mono text-sm tnum text-ink-soft">
        {fmtPhoneGrouped(sim.phone)}
      </div>

      <div className="mt-1 font-mono text-title tnum text-brass-deep">
        {sim.balance === null ? <span className="text-ink-faint">—</span> : fmtAmount(sim.balance)}
        {sim.balance !== null && (
          <span className="ml-1.5 text-sm font-normal tracking-normal text-ink-mute">Ks</span>
        )}
      </div>

      <div className="mt-0.5 space-y-0.5 text-xs">
        <div className="text-ink-faint">
          {sim.balance_checked_at ? `Read ${fmtTime(sim.balance_checked_at)}` : "Balance not read yet"}
        </div>
        {expiry && (
          <div
            title={blockTitleParts.join(" · ") || undefined}
            className={cn(
              "inline-flex items-center gap-1 font-mono text-[10.5px] tnum",
              expiry.tone === "alert"
                ? "text-alert-deep"
                : expiry.tone === "warn"
                  ? "text-brass-deep"
                  : "text-ink-mute"
            )}
          >
            <CalendarClock className="h-3 w-3 shrink-0" strokeWidth={1.75} />
            <span>{expiry.label}</span>
          </div>
        )}
      </div>

      {sim.note && <div className="relative z-10 mt-2 text-xs italic text-ink-mute">{sim.note}</div>}

      <div className="relative z-10 mt-auto pt-3">
        <div className="flex items-center justify-between gap-2 border-t border-hairline pt-3 transition-colors duration-300 group-hover:border-hairline-strong">
          {active ? (
            <>
              <TokenLife expiresAt={sim.token_expires_at} />
              {!selectionMode && (
                <div className="flex shrink-0 items-center gap-0.5">
                  {canRefresh && onRefresh && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onRefresh(sim)}
                      disabled={refreshing}
                      aria-label={`Read balance for ${fmtPhoneGrouped(sim.phone)}`}
                      title={
                        refreshCooldownActive
                          ? "No need to refresh yet — recently checked"
                          : "Read balance & expiry"
                      }
                      className={cn(
                        refreshCooldownActive && !refreshing && "text-ink-faint hover:text-ink-mute"
                      )}
                    >
                      <RefreshCw
                        className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
                        strokeWidth={1.5}
                      />
                    </Button>
                  )}
                  {canDelete && onRemove && (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => onRemove(sim)}
                      className="hover:text-alert-deep"
                      aria-label={`Remove ${fmtPhoneGrouped(sim.phone)}`}
                      title="Remove SIM"
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                    </Button>
                  )}
                </div>
              )}
            </>
          ) : (
            !selectionMode && (
              <>
                {canLogin && onLogin ? (
                  <Button variant="secondary" size="sm" onClick={() => onLogin(sim)}>
                    <LogIn className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
                    Log in again
                  </Button>
                ) : (
                  <span className="font-mono text-[10px] uppercase text-ink-faint">Logged out</span>
                )}
                {canDelete && onRemove && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => onRemove(sim)}
                    className="hover:text-alert-deep"
                    aria-label={`Remove ${fmtPhoneGrouped(sim.phone)}`}
                    title="Remove SIM"
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                  </Button>
                )}
              </>
            )
          )}
        </div>
      </div>
    </Panel>
  );
});

export interface SimChipProps {
  sim: Sim;
  selected: boolean;
  locked?: boolean;
  onSelect: (sim: Sim) => void;
}

function SimChip({ sim, selected, locked = false, onSelect }: SimChipProps) {
  const active = sim.status === "active";
  const atLimit = sim.volume_today >= DAILY_VOLUME_LIMIT || sim.volume_this_month >= MONTHLY_VOLUME_LIMIT;

  return (
    <div
      data-sim-phone={sim.phone}
      className={cn(
        "relative transition-[transform,filter] duration-300 ease-out motion-reduce:transition-none",
        selected && "drop-shadow-[0_6px_16px_rgb(var(--brass)/0.22)]"
      )}
      style={selected ? { transform: "translate3d(0, var(--sim-lift), 0)" } : undefined}
    >
      <Panel
        as="button"
        type="button"
        notch="sm"
        active={selected}
        disabled={!active}
        onClick={() => onSelect(sim)}
        aria-pressed={selected}
        contentClassName={cn(
          "relative overflow-hidden px-3.5 py-3 text-left transition-colors duration-300",
          !active && "bg-substrate"
        )}
        className={cn(
          "w-full text-left transition-colors duration-300",
          active && !selected && !locked && "motion-safe:active:scale-[0.985]",
          locked && "cursor-default"
        )}
      >
        {/* Warm brass tint + left accent bar fade in smoothly on the selected card. */}
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 bg-gradient-to-br from-brass/15 via-brass-wash/45 to-transparent dark:from-brass/20 dark:via-brass-wash/55 transition-opacity duration-300 ease-out",
            selected ? "opacity-100" : "opacity-0"
          )}
        />
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-0 left-0 w-[3px] bg-brass transition-opacity duration-300 ease-out",
            selected ? "opacity-100" : "opacity-0"
          )}
        />

        <div className="relative z-10 flex min-h-[20px] items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <StatusDot tone={active ? "signal" : "muted"} size="sm" pulse={active} />
            <span
              className={cn(
                "truncate font-mono text-xs font-medium tnum transition-colors duration-200",
                selected ? "text-ink" : "text-ink-soft"
              )}
            >
              {fmtPhoneGrouped(sim.phone)}
            </span>
          </span>
          <span
            aria-hidden="true"
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-sm bg-brass px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-wider text-substrate transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-opacity",
              selected ? "opacity-100 scale-100" : "pointer-events-none opacity-0 motion-safe:scale-90"
            )}
          >
            <Check className="h-2.5 w-2.5" strokeWidth={3} />
            Selected
          </span>
        </div>

        <div className="relative z-10 mt-1.5 font-mono text-lg tnum text-brass-deep">
          {active && sim.balance !== null ? (
            fmtAmount(sim.balance)
          ) : (
            <span className="text-sm text-ink-faint">
              {active ? "No balance read" : statusBadge(sim.status).label}
            </span>
          )}
          {active && sim.balance !== null && (
            <span className="ml-1 text-xs font-normal tracking-normal text-ink-mute">Ks</span>
          )}
        </div>

        <div className="relative z-10 mt-1.5 flex items-center justify-between gap-2 font-mono text-[10px] uppercase tnum">
          <span className={atLimit ? "text-alert-deep" : "text-ink-faint"}>
            {fmtAmount(sim.volume_today)}/{fmtAmount(DAILY_VOLUME_LIMIT)} today
          </span>
          <span className="text-ink-faint">
            {fmtAmount(sim.volume_this_month)}/{fmtAmount(MONTHLY_VOLUME_LIMIT)} mo
          </span>
        </div>
      </Panel>
    </div>
  );
}

export interface SimChipGridProps {
  sims: Sim[];
  selectedPhone: string;
  locked?: boolean;
  onSelect: (sim: Sim) => void;
  className?: string;
}

interface SelectionFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  animate: boolean;
}

/**
 * Grid of SimChip cards with a single shared notched brass outline that glides
 * smoothly across rows and columns when switching selection, instead of snapping
 * abruptly between cards.
 */
function SimChipGrid({ sims, selectedPhone, locked = false, onSelect, className }: SimChipGridProps) {
  const gridRef = React.useRef<HTMLDivElement>(null);
  const prevPhonesRef = React.useRef<string[]>([]);
  const prevSelectedRef = React.useRef<string>("");
  const [frame, setFrame] = React.useState<SelectionFrame | null>(null);

  const measure = React.useCallback(
    (animate: boolean) => {
      const grid = gridRef.current;
      if (!grid) return;

      if (!selectedPhone) {
        setFrame((prev) => (prev ? { ...prev, visible: false, animate: false } : null));
        return;
      }

      const nodes = Array.from(grid.querySelectorAll<HTMLElement>("[data-sim-phone]"));
      const target = nodes.find((el) => el.dataset.simPhone === selectedPhone);
      if (!target) {
        setFrame((prev) => (prev ? { ...prev, visible: false, animate: false } : null));
        return;
      }

      setFrame({
        x: target.offsetLeft,
        y: target.offsetTop,
        width: target.offsetWidth,
        height: target.offsetHeight,
        visible: true,
        animate,
      });
    },
    [selectedPhone]
  );

  React.useLayoutEffect(() => {
    const curPhones = sims.map((s) => s.phone);
    const prevSelected = prevSelectedRef.current;
    const prevPhones = prevPhonesRef.current;
    // Only glide when switching between two cards that are both in the stable visible grid.
    const canGlide =
      prevSelected !== "" &&
      prevSelected !== selectedPhone &&
      prevPhones.includes(prevSelected) &&
      curPhones.includes(prevSelected) &&
      curPhones.includes(selectedPhone);

    measure(canGlide);
    prevPhonesRef.current = curPhones;
    prevSelectedRef.current = selectedPhone;
  }, [sims, selectedPhone, measure]);

  React.useEffect(() => {
    const grid = gridRef.current;
    if (!grid || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure(false));
    ro.observe(grid);
    document.fonts?.ready.then(() => measure(false)).catch(() => {});
    return () => ro.disconnect();
  }, [measure]);

  return (
    <div
      ref={gridRef}
      className={cn("sim-chip-surface relative grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3", className)}
    >
      {frame && (
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute left-0 top-0 z-20",
            frame.animate
              ? "motion-safe:transition-[transform,opacity] motion-safe:duration-300 motion-reduce:transition-opacity"
              : "transition-opacity duration-200"
          )}
          style={{
            width: frame.width,
            height: frame.height,
            opacity: frame.visible ? 1 : 0,
            transform: `translate3d(${frame.x}px, calc(${frame.y}px + var(--sim-lift)), 0)`,
            transitionTimingFunction: frame.animate ? "cubic-bezier(0.22, 1, 0.36, 1)" : undefined,
          }}
        >
          <svg
            width={frame.width}
            height={frame.height}
            viewBox={`0 0 ${frame.width} ${frame.height}`}
            fill="none"
            className="block overflow-visible"
          >
            <polygon
              points={`1,1 ${Math.max(1, frame.width - 10.4)},1 ${Math.max(1, frame.width - 1)},10.4 ${Math.max(1, frame.width - 1)},${Math.max(1, frame.height - 1)} 1,${Math.max(1, frame.height - 1)}`}
              stroke="rgb(var(--brass))"
              strokeWidth={2}
              strokeLinejoin="miter"
            />
          </svg>
        </div>
      )}
      {sims.map((s) => (
        <SimChip
          key={s.phone}
          sim={s}
          selected={s.phone === selectedPhone}
          locked={locked}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export function SimCardSkeleton() {
  return (
    <Panel className="transition-all duration-300 ease-out" contentClassName="flex h-full flex-col p-5 relative overflow-hidden bg-card">
      <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent -translate-x-full animate-[shimmer_2s_infinite]" />
      <div className="flex items-center justify-between gap-3">
        <div className="h-5 w-24 animate-pulse rounded bg-substrate" />
        <div className="h-4 w-16 animate-pulse rounded bg-substrate" />
      </div>
      <div className="mt-4 h-4 w-28 animate-pulse rounded bg-substrate" />
      <div className="mt-2 h-7 w-32 animate-pulse rounded bg-substrate" />
      <div className="mt-1 h-3 w-24 animate-pulse rounded bg-substrate" />
      <div className="mt-5 flex items-center justify-between border-t border-hairline pt-3">
        <div className="h-4 w-32 animate-pulse rounded bg-substrate" />
        <div className="h-8 w-16 animate-pulse rounded bg-substrate" />
      </div>
    </Panel>
  );
}

function SimChipSkeleton() {
  return (
    <div className="notch notch-sm animate-pulse bg-hairline p-px">
      <div className="notch notch-sm bg-card px-3.5 py-3">
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-1.5 rounded-full bg-substrate" />
          <div className="h-3 w-28 rounded bg-substrate" />
        </div>
        <div className="mt-2 h-5 w-20 rounded bg-substrate" />
        <div className="mt-2 h-2.5 w-24 rounded bg-substrate" />
      </div>
    </div>
  );
}

export { SimCard, SimChip, SimChipGrid, SimChipSkeleton };
