"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowRight, Check, ClipboardPaste, Search, SquareStack, X } from "lucide-react";
import { Eyebrow } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel } from "@/components/ui/Panel";
import { OtpInput } from "@/components/ui/OtpInput";
import { EmptyState } from "@/components/ui/EmptyState";
import { SimChipGrid, SimChipSkeleton } from "@/components/SimCard";
import { Stepper } from "@/components/Stepper";
import { Receipt, ReceiptRow, ReceiptDivider } from "@/components/Receipt";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/SegmentedControl";
import { fmtAmount, fmtKs, fmtPhoneGrouped, fmtStamp } from "@/lib/format";
import { cn } from "@/lib/utils";
import { fetchSims, invalidateCache } from "@/lib/api";
import { isSimStateUpdate, useLive } from "@/lib/liveEvents";
import { CooldownSeconds, useCooldownActive } from "@/components/Cooldown";
import { useSessionState } from "@/lib/useSessionState";
import { useLocalState } from "@/lib/useLocalState";
import { DAILY_VOLUME_LIMIT, MONTHLY_VOLUME_LIMIT, TRANSFER_READY_MIN_BALANCE } from "@/lib/constants";
import { useSession } from "@/components/SessionProvider";
import type { Sim, TransferBalanceFilter, TransferSimCounts } from "@/lib/types";

const QUICK = [500, 800, 1000, 5000];
const RESEND_COOLDOWN = 60;
const SEARCH_DEBOUNCE_MS = 250;
const TRANSFER_SIM_LIMIT = 48;
const STEPS = ["Sender", "OTP", "Confirm"];

/**
 * How much of a SIM's MyShare allowance is used. `used` includes the amount
 * currently typed (limits count the transfer amount; the 5% fee is on top),
 * so the bar previews the impact before anything is sent.
 */
function LimitBar({ label, used, cap }: { label: string; used: number; cap: number }) {
  const pct = Math.min(100, Math.round((Math.max(0, used) / cap) * 100));
  // Amber from 60%, red at 80%+ — the bar warns before the API rejects.
  const warn = pct >= 60;
  const danger = pct >= 80;
  return (
    <div>
      <div className="flex items-baseline justify-between font-mono text-eyebrow uppercase">
        <span className="text-ink-mute">{label}</span>
        <span className={cn("tnum", danger ? "text-alert-deep" : warn ? "text-brass-deep" : "text-ink-faint")}>
          {fmtKs(Math.max(0, cap - Math.round(used)))} left
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-hairline">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500 ease-out",
            danger ? "bg-alert" : warn ? "bg-brass" : "bg-signal"
          )}
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={cap}
          aria-valuenow={Math.round(Math.max(0, used))}
        />
      </div>
    </div>
  );
}

interface Snapshot {
  sender: string;
  receiver: string;
  amount: number;
  fee: number;
  id: number | null;
  at: number;
}

export default function TransferPage() {
  const { loading: sessionLoading, permissions, rexFilter } = useSession();
  const [sims, setSims] = useState<Sim[]>([]);
  const [totalSims, setTotalSims] = useState(0);
  const [activeTotal, setActiveTotal] = useState(0);
  const [counts, setCounts] = useState<TransferSimCounts>({ all: 0, ready: 0, low: 0 });
  const [balanceFilter, setBalanceFilter] = useSessionState<TransferBalanceFilter>("transfer_balanceFilter", "ready");
  const [expandedSims, setExpandedSims] = useState(false);
  const [selectedCache, setSelectedCache] = useState<Sim | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sender, setSender] = useSessionState("transfer_sender", "");
  const [receiver, setReceiver] = useSessionState("transfer_receiver", "");
  const [amount, setAmount] = useSessionState("transfer_amount", "5000");
  const [otp, setOtp] = useSessionState("transfer_otp", "");
  const [searchQuery, setSearchQuery] = useState("");
  const [committedQuery, setCommittedQuery] = useState("");

  const [stage, setStage] = useSessionState<"form" | "otp" | "done">("transfer_stage", "form");
  const [busy, setBusy] = useState(false);
  const [otpError, setOtpError] = useState(false);
  const [receipt, setReceipt] = useSessionState<Snapshot | null>("transfer_receipt", null);
  const [recentContacts, setRecentContacts] = useLocalState<string[]>("recent_contacts", []);
  const [resendAt, setResendAt] = useSessionState("transfer_resendAt", 0);
  const requestSeq = useRef(0);
  const senderRef = useRef(sender);
  senderRef.current = sender;
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    const t = setTimeout(() => setCommittedQuery(searchQuery.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchQuery]);

  // Only the boolean lives here; the ticking digit is a leaf, so the whole form —
  // SIM chips, limit bars, receipt — isn't re-rendered once a second.
  const cooldownActive = useCooldownActive(resendAt);

  const loadSims = useCallback(
    (bypass = false) => {
      if (sessionLoading || !permissions.transfer.view) return Promise.resolve();
      const seq = ++requestSeq.current;
      const curSender = senderRef.current;
      return fetchSims({
        rexId: rexFilter,
        balanceFilter,
        q: committedQuery || undefined,
        includePhone: !committedQuery && curSender ? curSender : undefined,
        limit: TRANSFER_SIM_LIMIT,
        bypassCache: bypass,
        noDelay: true,
      })
        .then((res) => {
          if (seq !== requestSeq.current) return;
          const all = res.sims;
          setSims(all);
          setTotalSims(res.total);
          setActiveTotal(res.activeTotal);
          setCounts(res.counts);
          const matchInList = curSender ? all.find((s) => s.phone === curSender) : undefined;
          if (matchInList) {
            setSelectedCache(matchInList);
          }
          if (!committedQuery && stageRef.current !== "otp") {
            setSender((cur) => {
              if (cur && all.some((s) => s.phone === cur && s.status === "active")) return cur;
              const fallback = all.find((s) => s.status === "active");
              setSelectedCache(fallback ?? null);
              return fallback?.phone ?? "";
            });
          }
        })
        .catch(() => {})
        .finally(() => {
          if (seq === requestSeq.current) setLoaded(true);
        });
    },
    [setSender, rexFilter, balanceFilter, committedQuery, sessionLoading, permissions.transfer.view]
  );

  useEffect(() => {
    loadSims();
  }, [loadSims]);

  const loadSimsRef = useRef(loadSims);
  loadSimsRef.current = loadSims;
  useLive(
    () => {
      if (stageRef.current === "form" && !busyRef.current) {
        invalidateCache("sims");
        void loadSimsRef.current(true);
      }
    },
    { accept: isSimStateUpdate }
  );

  const balanceFilterOptions = useMemo<SegmentedOption<TransferBalanceFilter>[]>(
    () => [
      { value: "ready", label: `${fmtAmount(TRANSFER_READY_MIN_BALANCE)}+ ${fmtAmount(counts.ready)}` },
      { value: "low", label: `< ${fmtAmount(TRANSFER_READY_MIN_BALANCE)} ${fmtAmount(counts.low)}` },
      { value: "all", label: `All ${fmtAmount(counts.all)}` },
    ],
    [counts]
  );

  const selected = sims.find((s) => s.phone === sender) ?? (selectedCache?.phone === sender ? selectedCache : undefined);
  const senderBalance = selected?.balance ?? null;
  // Server already orders active SIMs (with quota headroom) first; preserve that cleanly.
  const orderedSims = useMemo(() => {
    const active = sims.filter((s) => s.status === "active");
    return [...active, ...sims.filter((s) => s.status !== "active")];
  }, [sims]);

  const displayedSims = useMemo(() => {
    if (committedQuery || searchQuery.trim()) {
      return orderedSims.slice(0, 12);
    }

    const maxCards = expandedSims ? 12 : 6;
    const top = orderedSims.slice(0, maxCards);
    if (sender && !top.some((s) => s.phone === sender)) {
      const currentSelected = orderedSims.find((s) => s.phone === sender);
      if (currentSelected) {
        return [currentSelected, ...top.slice(0, maxCards - 1)];
      }
    }
    return top;
  }, [orderedSims, committedQuery, searchQuery, sender, expandedSims]);
  const amt = Number(amount);
  const fee = Number.isFinite(amt) ? Math.round(amt * 0.05) : 0;
  const total = amt + fee;

  let amountError: string | undefined;
  if (amount !== "") {
    if (!Number.isFinite(amt) || amt < 500 || amt > 5000) {
      amountError = "Enter between 500 and 5,000 Ks.";
    } else if (selected) {
      if (amt + selected.volume_today > DAILY_VOLUME_LIMIT) {
        amountError = `Daily limit exceeded (${fmtKs(DAILY_VOLUME_LIMIT - selected.volume_today)} remaining).`;
      } else if (amt + selected.volume_this_month > MONTHLY_VOLUME_LIMIT) {
        amountError = `Monthly limit exceeded (${fmtKs(MONTHLY_VOLUME_LIMIT - selected.volume_this_month)} remaining).`;
      }
    }
  }

  const amountValid = amount !== "" && !amountError;
  const receiverValid = receiver.replace(/\D/g, "").length >= 9;
  const short = amountValid && senderBalance !== null && total > senderBalance;

  function failToast(r: { needsLogin?: boolean; error?: string; message?: string }, fallback: string) {
    if (r.needsLogin) {
      toast.error("Token expired", {
        description: `Log in ${fmtPhoneGrouped(sender)} again, then retry.`,
        action: { label: "SIM tray", onClick: () => window.location.assign("/sims") },
      });
      return;
    }
    toast.error(fallback, { description: r.error || r.message || undefined });
  }

  /** Telegram-copy workflow: one tap fills the receiver from the clipboard. */
  async function pasteReceiver() {
    if (locked) return;
    try {
      const text = await navigator.clipboard.readText();
      const cleaned = text.replace(/[^\d+]/g, "").slice(0, 15);
      if (!cleaned) {
        toast.error("Clipboard has no phone number");
        return;
      }
      setReceiver(cleaned);
      toast.success(`Pasted ${fmtPhoneGrouped(cleaned)}`);
    } catch {
      toast.error("Clipboard access denied — paste manually (long-press → Paste)");
    }
  }

  async function sendOtp() {
    if (!sender || !receiverValid || !amountValid) return;
    setBusy(true);
    try {
      const r = await fetch("/api/transfer/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: sender }),
      }).then((r) => r.json());
      if (r.ok) {
        setStage("otp");
        setResendAt(Math.floor(Date.now() / 1000) + RESEND_COOLDOWN);
        toast.success("OTP sent", {
          description: `Read the 6-digit code off ${fmtPhoneGrouped(sender)}.`,
        });
      } else {
        failToast(r, "Couldn't send the OTP");
      }
    } catch {
      toast.error("Network error", { description: "The console couldn't reach Mytel. Try again." });
    } finally {
      setBusy(false);
    }
  }

  async function confirmTransfer() {
    if (otp.length !== 6) return;
    setBusy(true);
    try {
      const r = await fetch("/api/transfer/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: sender, receiver, amount: amt, otp }),
      }).then((r) => r.json());
      if (r.ok) {
        setReceipt({
          sender,
          receiver,
          amount: amt,
          fee,
          id: r.transferId ?? null,
          at: Math.floor(Date.now() / 1000),
        });
        setStage("done");
        toast.success("Transfer sent", {
          description: `${fmtKs(amt)} to ${fmtPhoneGrouped(receiver)}.`,
        });
        invalidateCache();
        loadSims(true);
        setRecentContacts((prev) => {
          const filtered = prev.filter((p) => p !== receiver);
          return [receiver, ...filtered].slice(0, 3);
        });
      } else {
        failToast(r, "Transfer failed");
        setOtpError(true);
        setTimeout(() => {
          setOtp("");
          setOtpError(false);
        }, 500);
      }
    } catch {
      toast.error("Network error", { description: "The console couldn't reach Mytel. Try again." });
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStage("form");
    setOtp("");
    setAmount("5000");
    setReceiver("");
    setReceipt(null);
    setResendAt(0);
    setSearchQuery("");
    setTimeout(() => document.getElementById("to-input")?.focus(), 50);
  }

  if (!sessionLoading && !permissions.transfer.view) {
    return (
      <EmptyState
        title="Access restricted"
        body="Your role does not include Transfer access."
      />
    );
  }

  if (loaded && !committedQuery && activeTotal === 0 && stage === "form") {
    return (
      <EmptyState
        icon={
          <div className="relative w-24 h-24 flex items-center justify-center group-hover:scale-105 transition-transform duration-500">
            <div className="absolute inset-0 bg-gradient-to-br from-brass-soft/20 to-transparent rounded-2xl animate-pulse" />
            <div className="absolute -inset-2 bg-substrate rounded-3xl opacity-50 dark:opacity-10 blur-xl" />
            <div className="relative w-16 h-20 bg-card border border-hairline shadow-xl rounded-md flex flex-col p-2 notch-lg rotate-12 transition-transform duration-500 hover:rotate-6">
              <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-substrate to-transparent" />
              <SquareStack className="h-6 w-6 text-ink-mute m-auto z-10" strokeWidth={1.5} />
            </div>
          </div>
        }
        title="No SIM is logged in"
        body="A transfer needs a logged-in sender SIM — its OTP is what authorises the debit."
        action={
          permissions.sims.addLogin ? (
            <Button asChild className="shadow-md transition-transform hover:scale-105 active:scale-95">
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

  if (stage === "done" && receipt) {
    return (
      <div className="max-w-md mx-auto animate-rise-in">
        <Panel contentClassName="p-5">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-signal">
              <Check className="h-3 w-3 text-white" strokeWidth={3} aria-hidden="true" />
            </span>
            <Eyebrow className="text-ink">Transfer sent</Eyebrow>
          </div>

          <div className="mt-4">
            <Receipt>
              <ReceiptRow label="From" value={fmtPhoneGrouped(receipt.sender)} />
              <ReceiptRow label="To" value={fmtPhoneGrouped(receipt.receiver)} />
              <ReceiptDivider />
              <ReceiptRow label="Amount" value={fmtKs(receipt.amount)} />
              <ReceiptRow label="Fee (5%)" value={fmtKs(receipt.fee)} />
              <ReceiptDivider />
              <ReceiptRow label="Total debit" value={fmtKs(receipt.amount + receipt.fee)} emphasis />
            </Receipt>
          </div>

          <div className="mt-3 font-mono text-eyebrow uppercase tnum text-ink-faint">
            {fmtStamp(receipt.at)}
            {receipt.id !== null && ` · #${receipt.id}`}
          </div>
        </Panel>

        <div className="mt-5 flex gap-3">
          <Button autoFocus onClick={reset}>New transfer</Button>
          <Button asChild variant="ghost">
            <Link href="/history">View history</Link>
          </Button>
        </div>
      </div>
    );
  }

  const locked = stage === "otp";

  return (
    <div className="max-w-4xl mx-auto space-y-7">
      <Stepper steps={STEPS} current={stage === "otp" ? 1 : 0} className="w-full" />

      {/* Sender */}
      <section>
        <div className="flex flex-wrap items-center justify-between gap-2.5">
          <div className="flex flex-wrap items-center gap-2.5 min-w-0">
            <div className="flex items-center gap-2">
              <Eyebrow>From</Eyebrow>
              {totalSims > (expandedSims ? 12 : 6) && !searchQuery.trim() && (
                <span className="font-mono text-eyebrow uppercase text-ink-faint tnum">
                  ({Math.min(expandedSims ? 12 : 6, displayedSims.length)} of {totalSims})
                </span>
              )}
              {totalSims > 6 && !searchQuery.trim() && !locked && (
                <button
                  type="button"
                  onClick={() => setExpandedSims((v) => !v)}
                  className="font-mono text-[10px] uppercase tracking-wider text-brass-deep underline decoration-dotted underline-offset-2 hover:text-brass"
                >
                  {expandedSims ? "Show 6" : `Show ${Math.min(12, totalSims)}`}
                </button>
              )}
            </div>

            <div className="min-w-0 max-w-full overflow-x-auto scrollbar-none">
              <SegmentedControl<TransferBalanceFilter>
                aria-label="Filter sender SIMs by balance"
                value={balanceFilter}
                disabled={locked}
                onValueChange={(next) => {
                  setBalanceFilter(next);
                  setExpandedSims(false);
                }}
                options={balanceFilterOptions}
              />
            </div>
          </div>

          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              disabled={locked}
              placeholder="Search sender SIM..."
              className="h-8 w-full rounded border border-hairline bg-card pl-8 pr-7 text-xs text-ink placeholder:text-ink-faint transition-colors focus:border-brass focus:outline-none focus:ring-1 focus:ring-brass disabled:opacity-50"
            />
            {searchQuery && !locked && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink"
                title="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="mt-2.5">
          {!loaded ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {[1, 2, 3].map((i) => (
                <SimChipSkeleton key={i} />
              ))}
            </div>
          ) : displayedSims.length === 0 ? (
            <div className="w-full rounded border border-hairline bg-card p-6 text-center space-y-2">
              {searchQuery.trim() ? (
                <>
                  <p className="text-xs text-ink-mute">
                    No SIM found matching &quot;{searchQuery}&quot;
                    {balanceFilter !== "all"
                      ? ` in ${balanceFilter === "ready" ? `${fmtAmount(TRANSFER_READY_MIN_BALANCE)}+ Ks` : `< ${fmtAmount(TRANSFER_READY_MIN_BALANCE)} Ks`}`
                      : ""}
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={() => setSearchQuery("")}
                      className="font-mono text-xs text-brass-deep underline hover:text-ink"
                    >
                      Clear search
                    </button>
                    {balanceFilter !== "all" && (
                      <button
                        type="button"
                        onClick={() => setBalanceFilter("all")}
                        className="font-mono text-xs text-ink-mute underline hover:text-ink"
                      >
                        Search All SIMs
                      </button>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs text-ink-mute">
                    {balanceFilter === "ready"
                      ? `No active SIMs holding ${fmtAmount(TRANSFER_READY_MIN_BALANCE)}+ Ks right now.`
                      : `No active SIMs under ${fmtAmount(TRANSFER_READY_MIN_BALANCE)} Ks.`}
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-3">
                    {balanceFilter === "ready" && counts.low > 0 && (
                      <button
                        type="button"
                        onClick={() => setBalanceFilter("low")}
                        className="font-mono text-xs text-brass-deep underline hover:text-ink"
                      >
                        Show &lt; {fmtAmount(TRANSFER_READY_MIN_BALANCE)} ({fmtAmount(counts.low)})
                      </button>
                    )}
                    {balanceFilter === "low" && counts.ready > 0 && (
                      <button
                        type="button"
                        onClick={() => setBalanceFilter("ready")}
                        className="font-mono text-xs text-brass-deep underline hover:text-ink"
                      >
                        Show {fmtAmount(TRANSFER_READY_MIN_BALANCE)}+ ({fmtAmount(counts.ready)})
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => setBalanceFilter("all")}
                      className="font-mono text-xs text-ink-mute underline hover:text-ink"
                    >
                      Show All ({fmtAmount(counts.all)})
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <SimChipGrid
              sims={displayedSims}
              selectedPhone={sender}
              locked={locked}
              onSelect={(sim) => {
                if (locked) return;
                setSelectedCache(sim);
                setSender(sim.phone);
              }}
            />
          )}
        </div>
      </section>

      {/* Receiver + amount */}
      <section className="grid gap-5 sm:grid-cols-2">
        <div>
          <Input
            id="to-input"
            label="To"
            value={receiver}
            onChange={(e) => setReceiver(e.target.value.replace(/[^\d+]/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && sender && receiverValid && amountValid && !short && !busy) {
                sendOtp();
              }
            }}
            disabled={locked}
            autoFocus
            placeholder="09XXXXXXXXX"
            inputMode="numeric"
            autoComplete="off"
            className="font-mono"
            helperText="Any Mytel number, including one not in the tray."
            actionRight={
              <button
                type="button"
                tabIndex={-1}
                disabled={locked}
                onClick={pasteReceiver}
                aria-label="Paste number from clipboard"
                title="Paste from clipboard"
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded border border-hairline bg-substrate px-2",
                  "font-mono text-[10px] font-semibold uppercase tracking-wider text-ink-mute",
                  "transition-colors hover:border-brass hover:text-brass-deep",
                  "disabled:cursor-not-allowed disabled:opacity-50"
                )}
              >
                <ClipboardPaste className="h-3.5 w-3.5" strokeWidth={1.8} />
                Paste
              </button>
            }
          />
          {recentContacts.length > 0 && !locked && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {recentContacts.slice(0, 3).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setReceiver(c)}
                  className="rounded bg-substrate px-2.5 py-1 font-mono text-xs text-ink-mute transition-colors hover:bg-hairline hover:text-ink"
                >
                  {fmtPhoneGrouped(c)}
                </button>
              ))}
            </div>
          )}
        </div>
        <div>
          <Input
            id="amount-input"
            label="Amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && sender && receiverValid && amountValid && !short && !busy) {
                sendOtp();
              }
            }}
            disabled={locked}
            placeholder="500 – 5,000"
            inputMode="numeric"
            suffix="Ks"
            className="font-mono text-base tnum"
            error={amountError}
          />
          <div className="mt-2 flex gap-2">
            {QUICK.map((q) => (
              <Button
                key={q}
                variant="outline"
                size="sm"
                disabled={locked}
                onClick={() => {
                  setAmount(String(q));
                  document.getElementById("amount-input")?.focus();
                }}
                className="flex-1 font-mono tnum"
              >
                {q.toLocaleString()}
              </Button>
            ))}
          </div>
          {selected && (
            <div className="mt-3 space-y-2.5">
              <LimitBar
                label={`Daily · ${fmtPhoneGrouped(selected.phone)}`}
                used={selected.volume_today + (amountValid ? amt : 0)}
                cap={DAILY_VOLUME_LIMIT}
              />
              <LimitBar
                label="Monthly"
                used={selected.volume_this_month + (amountValid ? amt : 0)}
                cap={MONTHLY_VOLUME_LIMIT}
              />
            </div>
          )}
        </div>
      </section>

      {/* Money */}
      {amountValid && (
        <section className="max-w-sm">
          <Receipt>
            <ReceiptRow label="Amount" value={fmtKs(amt)} />
            <ReceiptRow label="Fee (5%)" value={fmtKs(fee)} />
            <ReceiptDivider />
            <ReceiptRow label="Total debit" value={fmtKs(total)} emphasis />
            {selected && senderBalance !== null && (
              <ReceiptRow
                label={`${fmtPhoneGrouped(selected.phone)} after`}
                value={fmtKs(senderBalance - total)}
                muted
              />
            )}
          </Receipt>
          {short && (
            <p className="mt-2 text-xs text-alert-deep">
              That&apos;s more than the last balance read for {fmtPhoneGrouped(sender)}. Read the balance
              again from the SIM tray, or send less.
            </p>
          )}
        </section>
      )}

      {/* OTP */}
      {locked && (
        <section className="animate-rise-in border-t border-hairline pt-6">
          <Eyebrow>Enter OTP</Eyebrow>
          <p className="mt-1.5 text-sm text-ink-mute">
            Sent by SMS to {fmtPhoneGrouped(sender)}
            {cooldownActive && (
              <span className="font-mono tnum text-ink-faint">
                {" "}
                · resend in <CooldownSeconds at={resendAt} />s
              </span>
            )}
          </p>
          <div className="mt-3.5">
            <OtpInput value={otp} onChange={(v) => { setOtp(v); setOtpError(false); }} autoFocus error={otpError} onSubmit={otp.length === 6 && !busy ? confirmTransfer : undefined} />
          </div>
        </section>
      )}

      {/* Actions */}
      <div className="flex flex-wrap gap-3 border-t border-hairline pt-6">
        {!permissions.transfer.execute ? (
          <p className="text-xs text-ink-mute">
            Your role allows viewing this page only — transfer execution is disabled.
          </p>
        ) : stage === "form" ? (
          <Button
            size="lg"
            loading={busy}
            disabled={!sender || !receiverValid || !amountValid || short}
            onClick={sendOtp}
          >
            {sender ? `Send OTP to ${fmtPhoneGrouped(sender)}` : "Send OTP"}
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
          </Button>
        ) : (
          <>
            <Button
              variant="brass"
              size="lg"
              loading={busy}
              disabled={otp.length !== 6}
              onClick={confirmTransfer}
            >
              Confirm {fmtKs(total)} debit
            </Button>
            <Button variant="outline" size="lg" disabled={busy || cooldownActive} onClick={sendOtp}>
              {cooldownActive ? (
                <>
                  Resend in <CooldownSeconds at={resendAt} />s
                </>
              ) : (
                "Resend OTP"
              )}
            </Button>
            <Button variant="ghost" size="lg" disabled={busy} onClick={reset}>
              Cancel
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
