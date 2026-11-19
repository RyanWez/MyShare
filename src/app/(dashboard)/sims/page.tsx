"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { toast } from "sonner";
import { BatteryLow, CalendarClock, Cpu, FolderInput, Plus, Search, SquareStack, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { OtpInput } from "@/components/ui/OtpInput";
import { EmptyState } from "@/components/ui/EmptyState";
import { ErrorBanner, ErrorState } from "@/components/ui/ErrorState";
import { Pagination } from "@/components/ui/Pagination";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl";
import { Select } from "@/components/ui/Select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/Dialog";
import { SimCard, SimCardSkeleton } from "@/components/SimCard";
import { fmtAmount, fmtKs, fmtPhoneGrouped, sameNumber } from "@/lib/format";
import { fetchSimsPage, invalidateCache, ApiError } from "@/lib/api";
import { LOW_BALANCE_THRESHOLD } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useLive } from "@/lib/liveEvents";
import { useSessionState } from "@/lib/useSessionState";
import { useSession } from "@/components/SessionProvider";
import { CooldownSeconds, useCooldownActive } from "@/components/Cooldown";
import type { Sim } from "@/lib/types";

type LoginMode = "otp" | "password";
type Flow = "login" | "register";
type View = "all" | "active" | "inactive" | "drained" | "expiring" | "expired";
type SortKey = "recent" | "balance-asc" | "balance-desc" | "expiry-asc";

const PAGE_SIZE = 24;
const SEARCH_DEBOUNCE_MS = 250;

const STAGGER: CSSProperties[] = Array.from({ length: 9 }, (_, i) => ({
  animationDelay: `${i * 40}ms`,
}));

export default function SimsPage() {
  const { loading: sessionLoading, permissions, rexFilter, rexGroups, refreshSession } = useSession();

  const [sims, setSims] = useState<Sim[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({
    all: 0,
    active: 0,
    inactive: 0,
    drained: 0,
    expiring: 0,
    expired: 0,
  });
  const [loaded, setLoaded] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>("all");
  const [sortBy, setSortBy] = useState<SortKey>("recent");
  const [page, setPage] = useState(1);

  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedSims, setSelectedSims] = useState<string[]>([]);
  const selectedSet = useMemo(() => new Set(selectedSims), [selectedSims]);
  const trayTopRef = useRef<HTMLDivElement>(null);
  const requestSeq = useRef(0);

  // Login modal state
  const [loginOpen, setLoginOpen] = useSessionState("login_open", false);
  const [mode, setMode] = useSessionState<LoginMode>("login_mode", "otp");
  const [phone, setPhone] = useSessionState("login_phone", "");
  const [otp, setOtp] = useSessionState("login_otp", "");
  const [password, setPassword] = useSessionState("login_password", "");
  const [targetRexId, setTargetRexId] = useState<string>("");
  const [otpSent, setOtpSent] = useSessionState("login_otpSent", false);
  const [otpError, setOtpError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flow, setFlow] = useSessionState<Flow>("login_flow", "login");
  const [reqId, setReqId] = useSessionState<string | null>("login_reqId", null);
  const [regSubId, setRegSubId] = useSessionState<string | null>("login_regSubId", null);
  const [loginResendAt, setLoginResendAt] = useSessionState("login_resendAt", 0);
  const cooldownActive = useCooldownActive(loginResendAt);

  const [pendingRemove, setPendingRemove] = useState<Sim | null>(null);
  const [pendingBulkRemove, setPendingBulkRemove] = useState(false);
  const [moveRexOpen, setMoveRexOpen] = useState(false);
  const [moveTargetRexId, setMoveTargetRexId] = useState<string>("");
  const [moving, setMoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const phoneInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [view, query, sortBy, rexFilter]);

  const load = useCallback(
    (background = false) => {
      if (sessionLoading || !permissions.sims.view) return;
      const seq = ++requestSeq.current;
      if (!background) setLoaded(false);
      setFetching(true);
      const opts = background ? { bypassCache: true, noDelay: true } : { noDelay: true };

      fetchSimsPage(
        {
          rexId: rexFilter,
          view,
          q: query || undefined,
          sort: sortBy,
          page,
          pageSize: PAGE_SIZE,
        },
        opts
      )
        .then((res) => {
          if (seq !== requestSeq.current) return;
          setSims(res.sims);
          setTotal(res.total);
          setCounts(res.counts);
          setError(null);
        })
        .catch((err) => {
          if (seq !== requestSeq.current) return;
          setError(err instanceof ApiError ? err.userMessage : "Something went wrong reading this.");
        })
        .finally(() => {
          if (seq !== requestSeq.current) return;
          setFetching(false);
          setLoaded(true);
        });
    },
    [sessionLoading, permissions.sims.view, rexFilter, view, query, sortBy, page]
  );

  useEffect(() => {
    load();
  }, [load]);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  });
  useLive(() => {
    invalidateCache("sims");
    loadRef.current(true);
  });

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), pageCount);

  useEffect(() => {
    if (loaded && page > pageCount) setPage(pageCount);
  }, [loaded, page, pageCount]);

  // If a conditional expiry tab disappears (count drops to 0 after refresh or Rex switch),
  // seamlessly fall back to "all" instead of leaving an invisible active filter.
  useEffect(() => {
    if (!loaded) return;
    if (view === "expiring" && counts.expiring === 0) setView("all");
    else if (view === "expired" && counts.expired === 0) setView("all");
  }, [loaded, view, counts.expiring, counts.expired]);

  const filterOptions = useMemo<SegmentedOption<View>[]>(() => {
    const opts: SegmentedOption<View>[] = [
      { value: "all", label: `All ${fmtAmount(counts.all)}` },
      { value: "active", label: `Active ${fmtAmount(counts.active)}` },
      { value: "inactive", label: `Needs login ${fmtAmount(counts.inactive)}` },
      { value: "drained", label: `Drained ${fmtAmount(counts.drained)}` },
    ];
    if (counts.expiring > 0) {
      opts.push({
        value: "expiring",
        label: `<10d ${fmtAmount(counts.expiring)}`,
        tone: "warn",
      });
    }
    if (counts.expired > 0) {
      opts.push({
        value: "expired",
        label: `Expired ${fmtAmount(counts.expired)}`,
        tone: "alert",
      });
    }
    return opts;
  }, [counts]);

  const goToPage = useCallback((next: number) => {
    setPage(next);
    trayTopRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const allPageSelected = sims.length > 0 && sims.every((s) => selectedSet.has(s.phone));

  const openLogin = useCallback(
    (prefill?: string) => {
      setPhone(prefill ?? "");
      setOtp("");
      setOtpError(false);
      setPassword("");
      setOtpSent(false);
      setMode("otp");
      setFlow("login");
      setReqId(null);
      setRegSubId(null);
      setTargetRexId(rexFilter !== "all" ? rexFilter : "");
      setLoginOpen(true);
    },
    [setPhone, setOtp, setPassword, setOtpSent, setMode, setFlow, setReqId, setRegSubId, setLoginOpen, rexFilter]
  );

  async function requestOtp() {
    if (!phone) return;
    setBusy(true);
    try {
      const res = await fetch("/api/auth/request-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone,
          ...(permissions.rex.viewAll && targetRexId ? { rexId: Number(targetRexId) } : {}),
        }),
      });
      const r = await res.json().catch(() => ({ ok: false, message: `Server error (${res.status})` }));
      if (res.ok && r.ok) {
        setOtpSent(true);
        setFlow(r.flow === "register" ? "register" : "login");
        setReqId(r.reqId ?? null);
        setRegSubId(r.subscriptionId ?? null);
        setLoginResendAt(Math.floor(Date.now() / 1000) + 45);
        toast.success("OTP sent", {
          description:
            r.flow === "register"
              ? `No MyID account on this number yet — the code will open one. Read it off ${fmtPhoneGrouped(phone)}.`
              : `Read the code off ${fmtPhoneGrouped(phone)}.`,
        });
      } else {
        const raw = r.message || r.error || "Check the number and try again.";
        const isMsisdnError = raw.includes("msisdnReq") || raw.includes("Invalid phone number");
        toast.error(isMsisdnError ? "Invalid phone number" : "Couldn't send the OTP", {
          description: raw,
        });
      }
    } catch (err: any) {
      toast.error("Network error", {
        description: err?.message || "The console couldn't reach Mytel. Try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function doLogin() {
    setBusy(true);
    try {
      const url = mode === "otp" ? "/api/auth/verify-otp" : "/api/auth/login-password";
      const rexPayload = permissions.rex.viewAll && targetRexId ? { rexId: Number(targetRexId) } : {};
      const body =
        mode === "otp"
          ? { phone, otp, reqId, subscriptionId: regSubId, ...rexPayload }
          : { phone, password, ...rexPayload };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const r = await res.json().catch(() => ({ ok: false, message: `Server error (${res.status})` }));
      if (res.ok && r.ok) {
        const needsBalanceRead = r.balance === null || r.balance === undefined;
        toast.success(
          r.registered
            ? `${fmtPhoneGrouped(phone)} registered and logged in`
            : `${fmtPhoneGrouped(phone)} logged in`,
          {
            description:
              !needsBalanceRead
                ? `Balance ${fmtKs(r.balance)}.`
                : "Syncing balance…",
          }
        );
        setLoginOpen(false);
        invalidateCache();
        load(true);
        void refreshSession();

        if (needsBalanceRead) {
          setTimeout(() => {
            void refreshBalance(phone);
          }, 600);
        }
      } else {
        const msg = r.message || r.error || "Check the code or password and try again.";
        const isNewCode = r.errorCode === 401 || String(msg).toLowerCase().includes("new code");
        if (mode === "otp") {
          setOtpError(true);
          setTimeout(() => {
            setOtp("");
            setOtpError(false);
          }, 500);
        }
        toast.error(
          flow !== "register" && isNewCode
            ? "Login failed - Mytel sent a new code, please wait for second SMS"
            : flow === "register"
              ? "Couldn't open the account"
              : "Login failed",
          { description: msg }
        );
      }
    } catch (err: any) {
      toast.error("Network error", {
        description: err?.message || "The console couldn't reach Mytel. Try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  const refreshBalance = useCallback(
    async (simOrPhone: Sim | string) => {
      const phoneNum = typeof simOrPhone === "string" ? simOrPhone : simOrPhone.phone;
      setRefreshing(phoneNum);
      try {
        const r = await fetch("/api/sims/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone: phoneNum }),
        }).then((res) => res.json());
        if (r.ok) {
          toast.success(`${fmtPhoneGrouped(phoneNum)} balance read`, {
            description:
              r.balance !== null && r.balance !== undefined
                ? `${fmtKs(r.balance)}${r.billExpireAt ? ` · Exp ${r.billExpireAt}` : ""}`
                : undefined,
          });
        } else if (r.needsLogin) {
          toast.error("Token expired", {
            description: `Log in ${fmtPhoneGrouped(phoneNum)} again to keep using it.`,
            action: permissions.sims.addLogin
              ? { label: "Log in", onClick: () => openLogin(phoneNum) }
              : undefined,
          });
        } else {
          toast.error("Couldn't read the balance", { description: r.message || r.error || undefined });
        }
        invalidateCache();
        load(true);
      } catch {
        toast.error("Network error", { description: "The console couldn't reach Mytel. Try again." });
      } finally {
        setRefreshing(null);
      }
    },
    [load, openLogin, permissions.sims.addLogin]
  );

  const toggleSelection = useCallback((sim: Sim) => {
    setSelectedSims((prev) =>
      prev.includes(sim.phone) ? prev.filter((p) => p !== sim.phone) : [...prev, sim.phone]
    );
  }, []);

  const requestRemove = useCallback((sim: Sim) => setPendingRemove(sim), []);
  const loginAgain = useCallback((sim: Sim) => openLogin(sim.phone), [openLogin]);

  const toggleSelectAllOnPage = useCallback(() => {
    setSelectedSims((prev) => {
      const pagePhones = sims.map((s) => s.phone);
      const allIn = pagePhones.length > 0 && pagePhones.every((p) => prev.includes(p));
      if (allIn) {
        const drop = new Set(pagePhones);
        return prev.filter((p) => !drop.has(p));
      }
      return [...new Set([...prev, ...pagePhones])];
    });
  }, [sims]);

  async function confirmRemove() {
    const sim = pendingRemove;
    if (!sim || deleting) return;
    setDeleting(true);
    try {
      const res = await fetch("/api/sims", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: sim.phone }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toast.success(`${fmtPhoneGrouped(sim.phone)} removed`, {
        description: "Its transfer history stays in the log.",
      });
      setPendingRemove(null);
      invalidateCache();
      load(true);
      void refreshSession();
    } catch {
      toast.error("Couldn't remove the SIM", { description: "Permission denied or network error." });
    } finally {
      setDeleting(false);
    }
  }

  async function confirmBulkRemove() {
    if (selectedSims.length === 0 || deleting) return;
    const phones = selectedSims;
    setDeleting(true);
    try {
      const res = await fetch("/api/sims", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phones }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json().catch(() => ({}));
      const removed = typeof body.removed === "number" ? body.removed : phones.length;
      toast.success(`${fmtAmount(removed)} ${removed === 1 ? "SIM" : "SIMs"} removed`, {
        description: "Their transfer histories stay in the log.",
      });
      setSelectedSims([]);
      setSelectionMode(false);
      setPendingBulkRemove(false);
      invalidateCache();
      load(true);
      void refreshSession();
    } catch {
      toast.error("Couldn't remove the SIMs", { description: "Permission denied or network error." });
    } finally {
      setDeleting(false);
    }
  }

  async function confirmMoveRex() {
    if (selectedSims.length === 0 || moving) return;
    setMoving(true);
    try {
      const res = await fetch("/api/sims", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phones: selectedSims,
          rexId: moveTargetRexId ? Number(moveTargetRexId) : null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      toast.success(`Moved ${fmtAmount(body.moved ?? selectedSims.length)} SIM(s)`);
      setSelectedSims([]);
      setSelectionMode(false);
      setMoveRexOpen(false);
      invalidateCache();
      load(true);
      void refreshSession();
    } catch (err: any) {
      toast.error("Couldn't move SIMs", { description: err?.message || "Try again." });
    } finally {
      setMoving(false);
    }
  }

  const canSelectAny = permissions.sims.delete || (permissions.sims.moveRex && permissions.rex.viewAll);
  const canSubmit = mode === "otp" ? otp.length === 6 : password.length > 0;
  const alreadyInTray = phone ? sims.find((s) => sameNumber(s.phone, phone)) : undefined;

  const emptyView = query
    ? {
        title: "No matching SIMs",
        body: `Nothing in ${view === "all" ? "the tray" : "this view"} matches "${query}".`,
      }
    : view === "drained"
      ? {
          title: "Nothing is drained",
          body: `Every SIM with a balance reading is holding at least ${fmtAmount(LOW_BALANCE_THRESHOLD)} Ks.`,
        }
      : view === "expiring"
        ? {
            title: "No SIMs expiring within 10 days",
            body: "All SIMs with a bill expiry reading have more than 10 days remaining.",
          }
        : view === "expired"
          ? {
              title: "No expired SIMs",
              body: "No SIM in this scope has passed its bill expiry date.",
            }
          : view === "inactive"
            ? {
                title: "Every SIM is logged in",
                body: "No token has expired, so nothing needs a fresh SMS code right now.",
              }
            : {
                title: "No active SIMs",
                body: "Every SIM in the tray needs logging in again before it can send.",
              };

  if (!sessionLoading && !permissions.sims.view) {
    return (
      <div className="max-w-5xl mx-auto pt-6">
        <EmptyState title="Access restricted" body="Your role does not include SIM Tray access." />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "max-w-6xl mx-auto space-y-5",
        selectionMode && selectedSims.length > 0 && "pb-24"
      )}
    >
      <div ref={trayTopRef} className="space-y-3 scroll-mt-24">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="font-mono text-eyebrow font-semibold uppercase tnum text-ink-mute">
            {total === counts.all ? (
              <>
                {fmtAmount(counts.all)} {counts.all === 1 ? "SIM" : "SIMs"} ·{" "}
                {fmtAmount(counts.active)} active
              </>
            ) : (
              <>
                {fmtAmount(total)} of {fmtAmount(counts.all)} {counts.all === 1 ? "SIM" : "SIMs"}
              </>
            )}
            {counts.drained > 0 && view !== "drained" && (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => setView("drained")}
                  className="inline-flex items-center gap-1 text-alert-deep underline decoration-dotted underline-offset-2 transition-colors hover:text-alert"
                >
                  <BatteryLow className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                  {fmtAmount(counts.drained)} under {fmtAmount(LOW_BALANCE_THRESHOLD)} Ks
                </button>
              </>
            )}
            {counts.expiring > 0 && view !== "expiring" && (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => setView("expiring")}
                  className="inline-flex items-center gap-1 text-brass-deep underline decoration-dotted underline-offset-2 transition-colors hover:text-brass"
                >
                  <CalendarClock className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                  {fmtAmount(counts.expiring)} expiring &lt;10d
                </button>
              </>
            )}
            {counts.expired > 0 && view !== "expired" && (
              <>
                {" · "}
                <button
                  type="button"
                  onClick={() => setView("expired")}
                  className="inline-flex items-center gap-1 text-alert-deep underline decoration-dotted underline-offset-2 transition-colors hover:text-alert"
                >
                  <CalendarClock className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
                  {fmtAmount(counts.expired)} expired
                </button>
              </>
            )}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-44 sm:w-56">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
              <input
                type="text"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search SIM or note..."
                className="h-8 w-full rounded border border-hairline bg-card pl-8 pr-7 text-xs text-ink placeholder:text-ink-faint transition-colors focus:border-brass focus:outline-none focus:ring-1 focus:ring-brass"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchInput("");
                    setQuery("");
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
                  title="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
            {counts.all > 0 && canSelectAny && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (selectionMode) {
                    setSelectionMode(false);
                    setSelectedSims([]);
                  } else {
                    setSelectionMode(true);
                  }
                }}
                className="shrink-0"
              >
                {selectionMode ? "Cancel" : "Select"}
              </Button>
            )}
            {permissions.sims.addLogin && (
              <Button
                size="sm"
                onClick={() => openLogin()}
                className="shrink-0 bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-500/40 font-medium shadow-sm shadow-emerald-950/40 transition-all hover:scale-105 active:scale-95"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
                Log in a SIM
              </Button>
            )}
          </div>
        </div>

        {counts.all > 0 && (
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="min-w-0 max-w-full overflow-x-auto scrollbar-none">
              <SegmentedControl<View>
                aria-label="Filter the tray"
                value={view}
                onValueChange={setView}
                options={filterOptions}
              />
            </div>

            <div className="flex shrink-0 items-center gap-2">
              {selectionMode && sims.length > 0 && (
                <Button variant="ghost" size="sm" onClick={toggleSelectAllOnPage}>
                  {allPageSelected
                    ? `Clear page`
                    : `Select page (${fmtAmount(sims.length)})`}
                </Button>
              )}
              <div className="flex items-center gap-2">
                <span className="font-mono text-eyebrow font-semibold uppercase text-ink-mute">
                  Sort
                </span>
                <Select<SortKey>
                  aria-label="Sort SIMs"
                  value={sortBy}
                  onValueChange={setSortBy}
                  align="right"
                  options={[
                    { value: "recent", label: "Last updated" },
                    { value: "expiry-asc", label: "Expiry: soonest first" },
                    { value: "balance-asc", label: "Balance: low to high" },
                    { value: "balance-desc", label: "Balance: high to low" },
                  ]}
                  triggerClassName="min-w-[164px]"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {error && sims.length > 0 && (
        <ErrorBanner what="the SIM tray" detail={error} onRetry={() => load(true)} retrying={fetching} />
      )}

      {!loaded || sessionLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <SimCardSkeleton key={i} />
          ))}
        </div>
      ) : error && counts.all === 0 ? (
        <ErrorState what="the SIM tray" detail={error} onRetry={() => load(true)} retrying={fetching} />
      ) : counts.all === 0 ? (
        <EmptyState
          icon={
            <div className="relative w-24 h-24 flex items-center justify-center group-hover:scale-105 transition-transform duration-500">
              <div className="relative w-16 h-20 bg-card border border-hairline shadow-xl rounded-md flex flex-col p-2 notch-lg rotate-12">
                <div className="absolute right-1 top-4 w-4 h-4 text-brass-deep/20">
                  <Cpu className="w-full h-full" strokeWidth={1.5} />
                </div>
                <div className="mt-auto flex gap-1">
                  <div className="w-3 h-1 bg-hairline rounded-full" />
                  <div className="w-2 h-1 bg-hairline rounded-full" />
                </div>
              </div>
              <div className="absolute -bottom-2 -left-2 w-12 h-16 bg-substrate border border-hairline shadow-lg rounded-md notch-sm -rotate-6 flex items-center justify-center">
                <SquareStack className="h-5 w-5 text-ink-mute" strokeWidth={1.5} />
              </div>
            </div>
          }
          title="The tray is empty"
          body={
            permissions.sims.addLogin
              ? "Log in a Mytel SIM with an SMS code or its MyID password to read balances and send transfers."
              : "No SIMs are assigned to this group yet."
          }
          action={
            permissions.sims.addLogin ? (
              <Button
                onClick={() => openLogin()}
                className="bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-500/40 font-medium shadow-md shadow-emerald-950/40 transition-all hover:scale-105 active:scale-95"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
                Log in a SIM
              </Button>
            ) : undefined
          }
        />
      ) : sims.length === 0 ? (
        <EmptyState
          icon={
            <div className="relative w-16 h-16 bg-card border border-hairline rounded-full flex items-center justify-center shadow-inner">
              {view === "drained" && !query ? (
                <BatteryLow className="h-7 w-7 text-ink-mute" strokeWidth={1.5} />
              ) : (view === "expiring" || view === "expired") && !query ? (
                <CalendarClock className="h-7 w-7 text-ink-mute" strokeWidth={1.5} />
              ) : (
                <Search className="h-7 w-7 text-ink-mute" strokeWidth={1.5} />
              )}
            </div>
          }
          title={emptyView.title}
          body={emptyView.body}
          action={
            query ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearchInput("");
                  setQuery("");
                }}
              >
                Clear search
              </Button>
            ) : view !== "all" ? (
              <Button variant="outline" size="sm" onClick={() => setView("all")}>
                Show the whole tray
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <div
            className={cn(
              "grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 transition-opacity",
              fetching && "opacity-60"
            )}
          >
            {sims.map((s, i) => (
              <SimCard
                key={s.id}
                sim={s}
                refreshing={refreshing === s.phone}
                onRefresh={refreshBalance}
                onRemove={requestRemove}
                onLogin={loginAgain}
                canRefresh={permissions.sims.refresh}
                canDelete={permissions.sims.delete}
                canLogin={permissions.sims.addLogin}
                showRex={permissions.rex.viewAll && rexFilter === "all"}
                selectionMode={selectionMode}
                selected={selectedSet.has(s.phone)}
                onSelectToggle={toggleSelection}
                className="animate-rise-in"
                style={STAGGER[Math.min(i, STAGGER.length - 1)]}
              />
            ))}
          </div>

          <Pagination
            currentPage={currentPage}
            pageCount={pageCount}
            pageSize={PAGE_SIZE}
            totalItems={total}
            onPageChange={goToPage}
            noun={["SIM", "SIMs"]}
          />
        </>
      )}

      {/* Login SIM Dialog */}
      <Dialog open={loginOpen} onOpenChange={setLoginOpen}>
        <DialogContent
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            phoneInputRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Log in a SIM</DialogTitle>
            <DialogDescription>
              Mytel authorises this console with the SIM&apos;s own credentials. A number with no
              MyID account yet gets one opened by the same SMS code.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-2">
            <SegmentedControl
              aria-label="Login method"
              value={mode}
              disabled={otpSent}
              onValueChange={(v) => {
                if (otpSent) return;
                setMode(v);
                setOtpSent(false);
                setFlow("login");
                setReqId(null);
                setRegSubId(null);
                setOtp("");
                setPassword("");
              }}
              options={[
                { value: "otp", label: "SMS code" },
                { value: "password", label: "MyID password" },
              ]}
              fullWidth
              className="w-full"
            />

            {permissions.rex.viewAll && rexGroups.length > 0 && (
              <div>
                <span className="mb-1.5 block font-mono text-eyebrow font-semibold uppercase text-ink-mute">
                  Assign to Rex category
                </span>
                <Select
                  aria-label="Assign SIM to Rex category"
                  value={targetRexId}
                  onValueChange={setTargetRexId}
                  disabled={otpSent}
                  className="w-full"
                  options={[
                    { value: "", label: "Unassigned (Admin only)" },
                    ...rexGroups.map((g) => ({ value: String(g.id), label: g.name })),
                  ]}
                />
              </div>
            )}

            <div className="space-y-4">
              <Input
                ref={phoneInputRef}
                label="Phone number"
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/[^\d+]/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && mode === "otp" && !otpSent && phone && !busy) {
                    requestOtp();
                  }
                }}
                disabled={mode === "otp" && otpSent}
                placeholder="09XXXXXXXXX"
                inputMode="numeric"
                autoComplete="off"
                className="font-mono"
              />

              {alreadyInTray && (
                <p className="text-xs leading-relaxed text-ink-mute">
                  {fmtPhoneGrouped(alreadyInTray.phone)} is already in the tray. Logging in again
                  replaces its stored token and keeps its place.
                </p>
              )}

              {mode === "otp"
                ? otpSent && (
                    <div className="animate-in fade-in slide-in-from-top-2 duration-300">
                      <div className="mb-2 flex items-center justify-between font-mono text-eyebrow font-semibold uppercase text-ink-mute">
                        <span>Code from SMS</span>
                        {cooldownActive && (
                          <span className="text-ink-faint">
                            resend in <CooldownSeconds at={loginResendAt} />s
                          </span>
                        )}
                      </div>

                      <div className="mt-1">
                        <OtpInput
                          value={otp}
                          onChange={(v) => {
                            setOtp(v);
                            setOtpError(false);
                          }}
                          autoFocus
                          error={otpError}
                          onSubmit={canSubmit && !busy ? doLogin : undefined}
                        />
                      </div>

                      {flow === "register" && (
                        <p className="mt-3 text-xs leading-relaxed text-ink-mute">
                          This number has no MyID account. Entering the code opens one and logs it in.
                        </p>
                      )}
                    </div>
                  )
                : (
                    <div className="animate-in fade-in slide-in-from-top-2 duration-300">
                      <Input
                        label="MyID password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && phone && canSubmit && !busy) {
                            doLogin();
                          }
                        }}
                        autoComplete="current-password"
                      />
                    </div>
                  )}
            </div>
          </div>

          <DialogFooter className="mt-4 gap-2 sm:space-x-0">
            <Button variant="ghost" onClick={() => setLoginOpen(false)} disabled={busy} className="sm:mr-auto">
              Cancel
            </Button>
            {mode === "otp" && otpSent && (
              <Button variant="outline" onClick={requestOtp} disabled={busy || cooldownActive}>
                {cooldownActive ? (
                  <>
                    Resend (<CooldownSeconds at={loginResendAt} />s)
                  </>
                ) : (
                  "Resend"
                )}
              </Button>
            )}
            {mode === "otp" && !otpSent ? (
              <Button onClick={requestOtp} loading={busy} disabled={!phone}>
                Send code
              </Button>
            ) : (
              <Button onClick={doLogin} loading={busy} disabled={!phone || !canSubmit}>
                {mode === "otp" && flow === "register" ? "Open account" : "Log in"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Single SIM */}
      <Dialog open={!!pendingRemove} onOpenChange={(o) => !o && setPendingRemove(null)}>
        <DialogContent onCloseAutoFocus={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Remove {pendingRemove && fmtPhoneGrouped(pendingRemove.phone)}?</DialogTitle>
            <DialogDescription>
              This drops the SIM and its stored tokens from the tray. Transfers it already made stay
              in the history.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingRemove(null)} disabled={deleting}>
              Keep it
            </Button>
            <Button variant="destructive" loading={deleting} onClick={confirmRemove}>
              Remove SIM
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Remove */}
      <Dialog open={pendingBulkRemove} onOpenChange={setPendingBulkRemove}>
        <DialogContent onCloseAutoFocus={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Remove {fmtAmount(selectedSims.length)} SIMs?</DialogTitle>
            <DialogDescription>
              This drops the selected SIMs and their stored tokens from the tray. Their transfer
              histories stay in the log.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPendingBulkRemove(false)} disabled={deleting}>
              Keep them
            </Button>
            <Button variant="destructive" loading={deleting} onClick={confirmBulkRemove}>
              Remove SIMs
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Move Rex Dialog */}
      <Dialog open={moveRexOpen} onOpenChange={setMoveRexOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Move {fmtAmount(selectedSims.length)} SIM(s) to Rex</DialogTitle>
            <DialogDescription>
              Reassign the selected SIMs to another Rex category. Past transfer logs remain under their
              original Rex.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Select
              aria-label="Target Rex category"
              value={moveTargetRexId}
              onValueChange={setMoveTargetRexId}
              className="w-full"
              options={[
                { value: "", label: "Unassigned (Admin only)" },
                ...rexGroups.map((g) => ({ value: String(g.id), label: g.name })),
              ]}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMoveRexOpen(false)} disabled={moving}>
              Cancel
            </Button>
            <Button loading={moving} onClick={confirmMoveRex}>
              Move SIMs
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Floating Bulk Action Bar */}
      {selectionMode && selectedSims.length > 0 && (
        <div className="fixed bottom-6 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2">
          <div className="flex animate-rise-in items-center gap-2 rounded-full border border-hairline bg-card p-2 pr-2 shadow-2xl sm:gap-3 sm:pr-4">
            <div className="flex h-10 items-center rounded-full bg-substrate px-3 font-mono text-sm font-semibold tnum sm:px-4">
              {fmtAmount(selectedSims.length)} selected
            </div>
            {permissions.sims.moveRex && permissions.rex.viewAll && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setMoveTargetRexId("");
                  setMoveRexOpen(true);
                }}
                className="rounded-full"
              >
                <FolderInput className="h-3.5 w-3.5" />
                Move Rex
              </Button>
            )}
            {permissions.sims.delete && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setPendingBulkRemove(true)}
                className="rounded-full"
              >
                Remove
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelectionMode(false);
                setSelectedSims([]);
              }}
              className="rounded-full"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
