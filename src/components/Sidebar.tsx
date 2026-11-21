"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Gauge,
  IdCard,
  ScrollText,
  Send,
  Settings,
  SquareStack,
  UserCog,
  Users,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/ui/StatusDot";
import { isSimInventoryUpdate, useLive, useLiveStatus, type LiveStatus } from "@/lib/liveEvents";
import { useSession } from "@/components/SessionProvider";
import { fetchFleetCounts, invalidateCache } from "@/lib/api";

const liveLed: Record<LiveStatus, { tone: "signal" | "alert" | "muted"; pulse?: boolean; title: string }> = {
  online: { tone: "signal", title: "Live — connected" },
  connecting: { tone: "muted", title: "Connecting to live updates…" },
  offline: { tone: "alert", pulse: true, title: "Live updates lost — reconnecting…" },
};

export interface SidebarProps {
  open: boolean;
  onClose: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

const EASE_EXPAND = "cubic-bezier(0.22, 1, 0.36, 1)";
const EASE_COLLAPSE = "cubic-bezier(0.45, 0.05, 0.25, 1)";

const widthMotion = (collapsed: boolean): React.CSSProperties => ({
  transition: collapsed
    ? `width 340ms ${EASE_COLLAPSE}, transform 380ms cubic-bezier(0.4, 0, 1, 1)`
    : `width 480ms ${EASE_EXPAND}, transform 440ms ${EASE_EXPAND}`,
});

const padMotion = (collapsed: boolean): React.CSSProperties => ({
  transition: collapsed
    ? `padding 340ms ${EASE_COLLAPSE}, gap 340ms ${EASE_COLLAPSE}, color 150ms ease, background-color 150ms ease`
    : `padding 480ms ${EASE_EXPAND}, gap 480ms ${EASE_EXPAND}, color 150ms ease, background-color 150ms ease`,
});

function RailLabel({
  collapsed,
  delay = 0,
  className,
  children,
}: {
  collapsed: boolean;
  delay?: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "overflow-hidden whitespace-nowrap",
        collapsed ? "max-w-0 -translate-x-2 opacity-0" : "max-w-[155px] translate-x-0 opacity-100",
        className
      )}
      style={{
        transition: collapsed
          ? "max-width 220ms cubic-bezier(0.4, 0, 1, 1), opacity 170ms ease-in, transform 220ms cubic-bezier(0.4, 0, 1, 1)"
          : `max-width 320ms ${EASE_EXPAND} ${delay}ms, opacity 240ms ease ${delay}ms, transform 320ms ${EASE_EXPAND} ${delay}ms`,
      }}
    >
      {children}
    </span>
  );
}

export default function Sidebar({ open, onClose, collapsed = false, onToggleCollapse }: SidebarProps) {
  const pathname = usePathname();
  const { user, permissions, rexFilter } = useSession();
  const [fleet, setFleet] = React.useState<{ total: number; active: number } | null>(null);
  const [userMenuOpen, setUserMenuOpen] = React.useState(true);
  const liveStatus = useLiveStatus();
  const led = liveLed[liveStatus];

  const navItems = React.useMemo(() => {
    const out = [];
    if (permissions.overview.view) out.push({ href: "/", label: "Overview", icon: Gauge });
    if (permissions.transfer.view) out.push({ href: "/transfer", label: "Transfer", icon: Send });
    if (permissions.sims.view) out.push({ href: "/sims", label: "SIM tray", icon: SquareStack });
    if (permissions.receivers.view) out.push({ href: "/receivers", label: "Receivers", icon: Users });
    if (permissions.history.view) out.push({ href: "/history", label: "History", icon: ScrollText });
    return out;
  }, [permissions]);

  const adminSubItems = React.useMemo(() => {
    const out = [];
    if (permissions.users.manage) out.push({ href: "/users", label: "Users", icon: UserCog });
    if (permissions.roles.manage) out.push({ href: "/roles", label: "Role Permission", icon: IdCard });
    return out;
  }, [permissions]);

  // Keep User Management expanded when visiting /users or /roles
  React.useEffect(() => {
    if (pathname.startsWith("/users") || pathname.startsWith("/roles")) {
      setUserMenuOpen(true);
    }
  }, [pathname]);

  const navRef = React.useRef<HTMLElement>(null);
  const [marker, setMarker] = React.useState<{ top: number; height: number } | null>(null);

  const measureMarker = React.useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    const el = nav.querySelector<HTMLElement>("a[data-nav][data-active='true']");
    if (!el) {
      setMarker(null);
      return;
    }
    setMarker({ top: el.offsetTop + 4, height: el.offsetHeight - 8 });
  }, []);

  React.useEffect(() => {
    measureMarker();
  }, [measureMarker, pathname, navItems, adminSubItems, userMenuOpen, collapsed]);

  React.useEffect(() => {
    const nav = navRef.current;
    if (!nav || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measureMarker());
    ro.observe(nav);
    document.fonts?.ready.then(() => measureMarker()).catch(() => {});
    return () => ro.disconnect();
  }, [measureMarker]);

  const canReadFleet = permissions.overview.view || permissions.sims.view || permissions.transfer.view;

  const loadFleet = React.useCallback(
    (bypass = false) => {
      if (!user || !canReadFleet) return;
      fetchFleetCounts({ rexId: rexFilter, bypassCache: bypass, noDelay: true })
        .then((d) => setFleet({ total: d.total, active: d.active }))
        .catch(() => {});
    },
    [user, canReadFleet, rexFilter]
  );

  React.useEffect(() => {
    loadFleet();
  }, [loadFleet]);

  useLive(
    () => {
      invalidateCache("fleet");
      loadFleet(true);
    },
    { accept: isSimInventoryUpdate }
  );

  return (
    <>
      <div
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-40 bg-black/60 transition-opacity md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        aria-hidden="true"
      />

      <aside
        style={widthMotion(collapsed)}
        className={cn(
          "fixed inset-y-0 left-0 z-50 md:z-40 flex shrink-0 flex-col bg-[#0D101A] text-[#F4F7FE] border-r border-white/[0.08] will-change-[width,transform] md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
          collapsed ? "w-20" : "w-60"
        )}
      >
        {onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className="absolute -right-3 top-[58px] z-50 hidden md:flex h-6 w-6 items-center justify-center rounded-full border border-white/15 bg-[#151A28] text-white/80 shadow-lift transition-all hover:scale-110 hover:border-brass/60 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5 transition-transform duration-300" />
            ) : (
              <ChevronLeft className="h-3.5 w-3.5 transition-transform duration-300" />
            )}
          </button>
        )}

        <div className={cn("flex min-h-[70px] items-center border-b border-white/10 px-5", collapsed && "px-4")}>
          <div className="relative h-5 min-w-0 flex-1">
            <div
              className={cn(
                "absolute inset-0 flex items-center",
                collapsed ? "-translate-x-1 opacity-0" : "translate-x-0 opacity-100"
              )}
              style={{
                transition: collapsed
                  ? "opacity 140ms ease-in, transform 140ms ease-in"
                  : `opacity 240ms ease 140ms, transform 320ms ${EASE_EXPAND} 140ms`,
              }}
            >
              <div className="font-mono text-[15px] font-bold uppercase tracking-[0.16em] text-white">
                My<span className="text-brass">Share</span>
              </div>
            </div>
            <div
              className={cn(
                "absolute inset-0 flex items-center justify-center font-mono text-sm font-semibold uppercase text-brass",
                collapsed ? "opacity-100" : "opacity-0"
              )}
              style={{
                transition: collapsed ? "opacity 220ms ease 180ms" : "opacity 160ms ease",
              }}
              aria-hidden="true"
            >
              MS
            </div>
          </div>
          <button
            onClick={onClose}
            className={cn("-mr-1 rounded p-1 text-white/50 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brass md:hidden", collapsed && "hidden")}
            aria-label="Close menu"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>
        </div>

        <nav ref={navRef} className="relative flex-1 overflow-y-auto overflow-x-hidden py-3">
          <span
            aria-hidden="true"
            className={cn(
              "absolute left-0 w-[2px] rounded-r bg-brass transition-[top,height,opacity] duration-300 ease-out",
              !marker && "opacity-0"
            )}
            style={{ top: marker?.top ?? 0, height: marker?.height ?? 0 }}
          />
          {navItems.map((it, i) => {
            const active = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
            const Icon = it.icon;
            return (
              <Link
                key={it.href}
                href={it.href}
                data-nav
                data-active={active ? "true" : "false"}
                onClick={onClose}
                title={collapsed ? it.label : undefined}
                aria-current={active ? "page" : undefined}
                style={padMotion(collapsed)}
                className={cn(
                  "relative flex items-center py-2.5 font-mono text-eyebrow font-semibold uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brass",
                  collapsed ? "pl-8 pr-0" : "pl-5 pr-4",
                  active ? "text-white bg-white/[0.08]" : "text-white/55 hover:text-white/95 hover:bg-white/[0.04]"
                )}
              >
                <span className="relative flex shrink-0">
                  <Icon
                    className={cn("h-4 w-4 transition-colors", active && "text-brass")}
                    strokeWidth={1.5}
                    aria-hidden="true"
                  />
                  <RailLabel
                    collapsed={collapsed}
                    delay={100 + i * 40}
                    className="absolute left-full top-1/2 ml-3 -translate-y-1/2"
                  >
                    {it.label}
                  </RailLabel>
                </span>
              </Link>
            );
          })}

          {adminSubItems.length > 0 && (
            <div className="mt-3 border-t border-white/[0.07] pt-3">
              {!collapsed && (
                <button
                  type="button"
                  onClick={() => setUserMenuOpen((o) => !o)}
                  aria-expanded={userMenuOpen}
                  className="flex w-full items-center justify-between px-5 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-white/45 transition-colors hover:text-white/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brass"
                >
                  <span className="flex items-center gap-2.5">
                    <Settings className="h-3.5 w-3.5 shrink-0" strokeWidth={1.5} aria-hidden="true" />
                    <span>User Management</span>
                  </span>
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform duration-200",
                      userMenuOpen && "rotate-180"
                    )}
                    strokeWidth={1.75}
                  />
                </button>
              )}

              {(collapsed || userMenuOpen) && (
                <div className="space-y-0.5">
                  {adminSubItems.map((it, i) => {
                    const active = pathname.startsWith(it.href);
                    const Icon = it.icon;
                    return (
                      <Link
                        key={it.href}
                        href={it.href}
                        data-nav
                        data-active={active ? "true" : "false"}
                        onClick={onClose}
                        title={collapsed ? it.label : undefined}
                        aria-current={active ? "page" : undefined}
                        style={padMotion(collapsed)}
                        className={cn(
                          "relative flex items-center py-2.5 font-mono text-eyebrow font-semibold uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brass",
                          collapsed ? "pl-8 pr-0" : "pl-8 pr-4",
                          active
                            ? "text-white bg-white/[0.08]"
                            : "text-white/55 hover:text-white/95 hover:bg-white/[0.04]"
                        )}
                      >
                        <span className="relative flex shrink-0">
                          <Icon
                            className={cn("h-4 w-4 transition-colors", active && "text-brass")}
                            strokeWidth={1.5}
                            aria-hidden="true"
                          />
                          <RailLabel
                            collapsed={collapsed}
                            delay={120 + i * 40}
                            className="absolute left-full top-1/2 ml-3 -translate-y-1/2"
                          >
                            {it.label}
                          </RailLabel>
                        </span>
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </nav>

        <div
          className={cn("border-t border-white/10 py-3.5 space-y-2.5", collapsed ? "px-0" : "px-5")}
          style={{ transition: collapsed ? `padding 340ms ${EASE_COLLAPSE}` : `padding 480ms ${EASE_EXPAND}` }}
        >
          {user && !collapsed && (
            <div className="flex items-center justify-between gap-2 rounded bg-white/[0.04] px-2.5 py-2 border border-white/[0.06]">
              <div className="min-w-0">
                <div className="truncate font-mono text-[11px] font-semibold text-white">
                  {user.username}
                </div>
                <div className="truncate font-mono text-[9.5px] uppercase tracking-wider text-white/50">
                  {user.roleName} · {user.rexName ?? (permissions.rex.viewAll ? "All Rex" : "Unassigned")}
                </div>
              </div>
            </div>
          )}

          <div
            className={cn(
              "flex items-center font-mono text-[10px] tracking-wider uppercase text-white/60",
              collapsed ? "pl-8" : "pl-0"
            )}
            style={padMotion(collapsed)}
            title={led.title}
          >
            <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
              <StatusDot tone={led.tone} size="sm" pulse={led.pulse} />
              <RailLabel
                collapsed={collapsed}
                delay={220}
                className="absolute left-full top-1/2 ml-2.5 -translate-y-1/2 tnum"
              >
                {fleet ? (
                  <span className="text-white/70">
                    {fleet.active} of {fleet.total} SIMs active
                  </span>
                ) : (
                  <span className="text-white/35">Reading tray…</span>
                )}
              </RailLabel>
            </span>
          </div>
        </div>
      </aside>
    </>
  );
}
