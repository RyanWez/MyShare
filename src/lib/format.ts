export type Tone = "signal" | "alert" | "brass" | "muted";

export function fmtKs(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-US") + " Ks";
}

/** Amount without the unit, for when "Ks" is set as a separate label. */
export function fmtAmount(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-US");
}

/** 959... -> 09... */
export function fmtPhone(p: string): string {
  if (p.startsWith("95")) return "0" + p.slice(2);
  return p;
}

/**
 * 09 750 111 222 — grouped for scanning down a column.
 * Handles both stored forms: senders are normalized to `959…`, receivers are
 * stored raw as typed (see the plan's out-of-scope note).
 */
export function fmtPhoneGrouped(p: string): string {
  const local = fmtPhone(p);
  const digits = local.replace(/\D/g, "");
  if (digits.length < 5) return local;
  const groups = digits.slice(2).match(/.{1,3}/g) ?? [];
  return [digits.slice(0, 2), ...groups].join(" ");
}

/**
 * Do two typed-or-stored numbers mean the same SIM?
 *
 * Compares the last 9 digits, which is what survives every form the app sees:
 * `09750111222`, `+959750111222`, `959750111222`.
 */
export function sameNumber(a: string, b: string): boolean {
  const tail = (s: string) => s.replace(/\D/g, "").slice(-9);
  const ta = tail(a);
  return ta.length === 9 && ta === tail(b);
}

/**
 * Every digit form that means this same number, so search matches across
 * formats: senders are stored as `959…` (normalizeMsisdn) while receivers keep
 * whatever was typed (`09…`, `959…`, even bare `9…`). A query in one form must
 * still hit rows stored in another.
 */
export function phoneSearchKeys(phone: string): string[] {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return [];
  const keys = new Set<string>([digits]);
  const local = fmtPhone(digits); // 95… → 09…
  keys.add(local);
  keys.add(local.replace(/^0/, "")); // …without the leading zero: 9…
  if (/^9\d{8,}$/.test(digits)) keys.add("0" + digits); // bare 9… → 09…
  return [...keys];
}

export function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 14:32 */
export function fmtClock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** THU 20 AUG — history day dividers */
export function fmtDayHeader(ts: number): string {
  return new Date(ts * 1000)
    .toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" })
    .replace(",", "")
    .toUpperCase();
}

/** 20 Aug 2026 · 14:32 — receipt footer */
export function fmtStamp(ts: number): string {
  const d = new Date(ts * 1000);
  const date = d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `${date} · ${fmtClock(ts)}`;
}

/** Groups history rows by calendar day. */
export function dayKey(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** 4m 12s · 42s — short countdown, for horizons under an hour */
export function fmtCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= 3600) {
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  if (s >= 60) {
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  }
  return `${s}s`;
}

/**
 * 19 Sep — a date reads better than "737h 47m" for a long-lived token.
 * The month is cut to three letters by hand: en-GB's "short" gives "Sept",
 * "June", "July", and the extra letter overflows the SIM card footer.
 */
export function fmtShortDate(ts: number): string {
  const d = new Date(ts * 1000);
  const month = d.toLocaleDateString("en-GB", { month: "short" }).slice(0, 3);
  return `${d.getDate()} ${month}`;
}

/**
 * Semantic tone per status — components map the tone to color, so the palette
 * lives in one place instead of being hardcoded here.
 */
export function statusBadge(status: string): { label: string; tone: Tone } {
  switch (status) {
    case "active":
      return { label: "Active", tone: "signal" };
    case "logged_out":
      return { label: "Logged out", tone: "muted" };
    case "otp_pending":
      return { label: "Waiting for OTP", tone: "brass" };
    case "success":
      return { label: "Sent", tone: "signal" };
    case "failed":
      return { label: "Failed", tone: "alert" };
    case "pending":
      return { label: "Pending", tone: "brass" };
    default:
      return { label: status, tone: "muted" };
  }
}

const NATURAL_COLLATOR = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

/** Natural case-insensitive comparison so "Rex-2" sorts before "Rex-12". */
export function compareNatural(a: string, b: string): number {
  return NATURAL_COLLATOR.compare(a, b);
}

function userRoleTier(roleName: string): number {
  const lower = roleName.toLowerCase();
  if (lower === "admin") return 0;
  if (lower === "staff") return 1;
  return 2;
}

export interface SortableOperatorUser {
  is_env_admin: boolean;
  role_name: string;
  is_active: boolean;
  rex_name: string | null;
  username: string;
}

/**
 * Sort operators with Root (.env) and Admin roles pinned at the top, followed
 * by Staff and custom roles below (active first, then natural Rex & username).
 */
export function compareOperatorUsers(a: SortableOperatorUser, b: SortableOperatorUser): number {
  if (a.is_env_admin !== b.is_env_admin) return a.is_env_admin ? -1 : 1;
  const tierA = userRoleTier(a.role_name);
  const tierB = userRoleTier(b.role_name);
  if (tierA !== tierB) return tierA - tierB;
  if (tierA === 2) {
    const roleCmp = compareNatural(a.role_name, b.role_name);
    if (roleCmp !== 0) return roleCmp;
  }
  if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
  const rexA = a.rex_name ?? "";
  const rexB = b.rex_name ?? "";
  if ((rexA === "") !== (rexB === "")) return rexA === "" ? -1 : 1;
  const rexCmp = compareNatural(rexA, rexB);
  if (rexCmp !== 0) return rexCmp;
  return compareNatural(a.username, b.username);
}

const MM_OFFSET_MS = (6 * 60 + 30) * 60 * 1000;

function validIsoDate(year: number, month: number, day: number): string | null {
  if (year < 1970 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Parse Mytel's `billExpireAt` string into an ISO `YYYY-MM-DD` date (Asia/Yangon)
 * for indexed PostgreSQL `DATE` storage & expiry queries.
 */
export function parseBillExpireDate(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;

  let m = s.match(/^(0[1-9]|[12][0-9]|3[01])\/(0[1-9]|1[0-2])\/([0-9]{4})/);
  if (m) return validIsoDate(Number(m[3]), Number(m[2]), Number(m[1]));

  m = s.match(/^(0[1-9]|[12][0-9]|3[01])-(0[1-9]|1[0-2])-([0-9]{4})/);
  if (m) return validIsoDate(Number(m[3]), Number(m[2]), Number(m[1]));

  m = s.match(/^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])/);
  if (m) return validIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));

  if (/^[0-9]{13}$/.test(s)) {
    const d = new Date(Number(s) + MM_OFFSET_MS);
    return validIsoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  if (/^[0-9]{10}$/.test(s)) {
    const d = new Date(Number(s) * 1000 + MM_OFFSET_MS);
    return validIsoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  return null;
}
