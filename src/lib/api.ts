import type {
  ReceiversResponse,
  Sim,
  SimsPageResponse,
  StatsResponse,
  Transfer,
  TransferBalanceFilter,
  TransferSimCounts,
} from "./types";

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();
const DEFAULT_TTL_MS = 3500;

export class ApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }

  get userMessage(): string {
    if (this.status === null) return "Couldn't reach the console server.";
    if (this.status === 401) return "Session expired — sign in again.";
    if (this.status === 403) return "You don't have permission to access this.";
    if (this.status === 429) return "The console is rate-limiting this request. Try again shortly.";
    if (this.status >= 500) return "The console server errored while reading this.";
    return `The console server refused this request (HTTP ${this.status}).`;
  }
}

async function requestJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new ApiError((err as Error)?.message || "Network request failed", null);
  }
  if (!res.ok) {
    throw new ApiError(`HTTP ${res.status}: ${res.statusText}`, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError("The server sent a response this page couldn't read", res.status);
  }
}

async function cachedFetch<T>(
  key: string,
  url: string,
  ttlMs: number = DEFAULT_TTL_MS,
  opts?: { bypassCache?: boolean; noDelay?: boolean }
): Promise<T> {
  const now = Date.now();
  if (!opts?.bypassCache) {
    const cached = cache.get(key);
    if (cached && now - cached.timestamp < ttlMs) {
      return cached.data as T;
    }
    if (inFlight.has(key)) {
      return inFlight.get(key) as Promise<T>;
    }
  } else {
    cache.delete(key);
    if (inFlight.has(key)) {
      return inFlight.get(key) as Promise<T>;
    }
  }

  const delay = opts?.noDelay ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, 200));

  const promise = Promise.all([requestJson<T>(url), delay])
    .then(([data]) => {
      cache.set(key, { data, timestamp: Date.now() });
      return data;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, promise);
  return promise;
}

export function invalidateCache(prefix?: string) {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
}

export async function fetchStats(
  from?: number,
  to?: number,
  opts?: { bypassCache?: boolean; noDelay?: boolean; rexId?: string }
): Promise<StatsResponse> {
  const params = new URLSearchParams();
  if (from && to) {
    params.set("from", String(from));
    params.set("to", String(to));
  }
  if (opts?.rexId && opts.rexId !== "all") params.set("rexId", opts.rexId);
  const qs = params.toString();
  const key = `stats:${from || "def"}:${to || "def"}:${opts?.rexId || "all"}`;
  return cachedFetch<StatsResponse>(key, qs ? `/api/stats?${qs}` : "/api/stats", 3000, opts);
}

export interface SimsListResponse {
  sims: Sim[];
  total: number;
  activeTotal: number;
  counts: TransferSimCounts;
}

export async function fetchSims(opts?: {
  bypassCache?: boolean;
  noDelay?: boolean;
  rexId?: string;
  status?: string;
  balanceFilter?: TransferBalanceFilter;
  q?: string;
  includePhone?: string;
  limit?: number;
}): Promise<SimsListResponse> {
  const params = new URLSearchParams();
  if (opts?.rexId && opts.rexId !== "all") params.set("rexId", opts.rexId);
  if (opts?.status) params.set("status", opts.status);
  if (opts?.balanceFilter && opts.balanceFilter !== "all") params.set("balanceFilter", opts.balanceFilter);
  if (opts?.q) params.set("q", opts.q);
  if (opts?.includePhone) params.set("includePhone", opts.includePhone);
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const key = `sims:${opts?.rexId || "all"}:${opts?.status || "all"}:${opts?.balanceFilter || "all"}:${opts?.q || ""}:${opts?.includePhone || ""}:${opts?.limit ?? 48}`;
  const data = await cachedFetch<{
    ok: boolean;
    sims: Sim[];
    total?: number;
    activeTotal?: number;
    counts?: TransferSimCounts;
  }>(
    key,
    qs ? `/api/sims?${qs}` : "/api/sims",
    3000,
    opts
  );
  const sims = data.sims ?? [];
  const activeCount = data.activeTotal ?? sims.filter((s) => s.status === "active").length;
  return {
    sims,
    total: data.total ?? sims.length,
    activeTotal: activeCount,
    counts: data.counts ?? {
      all: data.total ?? sims.length,
      ready: sims.filter((s) => s.status === "active" && s.balance !== null && s.balance >= 5250).length,
      low: sims.filter((s) => s.status === "active" && s.balance !== null && s.balance < 5250).length,
    },
  };
}

export async function fetchFleetCounts(opts?: {
  bypassCache?: boolean;
  noDelay?: boolean;
  rexId?: string;
}): Promise<{ total: number; active: number }> {
  const params = new URLSearchParams();
  if (opts?.rexId && opts.rexId !== "all") params.set("rexId", opts.rexId);
  const qs = params.toString();
  const key = `fleet:${opts?.rexId || "all"}`;
  const data = await cachedFetch<{ ok: boolean; total: number; active: number }>(
    key,
    qs ? `/api/sims/fleet?${qs}` : "/api/sims/fleet",
    4000,
    opts
  );
  return { total: data.total ?? 0, active: data.active ?? 0 };
}

export interface SimsPageQuery {
  rexId?: string;
  view?: "all" | "active" | "inactive" | "drained" | "expiring" | "expired";
  q?: string;
  sort?: "recent" | "balance-asc" | "balance-desc" | "expiry-asc";
  page: number;
  pageSize: number;
}

export async function fetchSimsPage(
  query: SimsPageQuery,
  opts?: { bypassCache?: boolean; noDelay?: boolean }
): Promise<SimsPageResponse> {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.rexId && query.rexId !== "all") params.set("rexId", query.rexId);
  if (query.view) params.set("view", query.view);
  if (query.q) params.set("q", query.q);
  if (query.sort) params.set("sort", query.sort);

  const key = `simsPage:${query.rexId ?? "all"}:${query.view ?? "all"}:${query.q ?? ""}:${query.sort ?? "recent"}:${query.page}:${query.pageSize}`;
  const data = await cachedFetch<SimsPageResponse & { ok: boolean }>(
    key,
    `/api/sims?${params.toString()}`,
    2500,
    opts
  );
  return {
    sims: data.sims ?? [],
    total: data.total ?? 0,
    counts: data.counts ?? { all: 0, active: 0, inactive: 0, drained: 0 },
  };
}

export interface HistoryQuery {
  from?: number;
  to?: number;
  status?: string;
  q?: string;
  rexId?: string;
  page: number;
  pageSize: number;
}

export interface HistoryPage {
  transfers: Transfer[];
  total: number;
}

export async function fetchHistoryPage(
  query: HistoryQuery,
  opts?: { bypassCache?: boolean; noDelay?: boolean }
): Promise<HistoryPage> {
  const params = new URLSearchParams({
    page: String(query.page),
    pageSize: String(query.pageSize),
  });
  if (query.from !== undefined) params.set("from", String(query.from));
  if (query.to !== undefined) params.set("to", String(query.to));
  if (query.status) params.set("status", query.status);
  if (query.q) params.set("q", query.q);
  if (query.rexId && query.rexId !== "all") params.set("rexId", query.rexId);

  const key = `history:${query.from ?? "all"}:${query.to ?? "all"}:${query.status ?? "all"}:${query.q ?? ""}:${query.rexId ?? "all"}:${query.page}:${query.pageSize}`;
  const data = await cachedFetch<HistoryPage & { ok: boolean }>(
    key,
    `/api/history?${params.toString()}`,
    1500,
    opts
  );
  return { transfers: data.transfers ?? [], total: data.total ?? 0 };
}

export async function fetchReceivers(
  from?: number,
  to?: number,
  sender?: string,
  opts?: { bypassCache?: boolean; noDelay?: boolean; rexId?: string }
): Promise<ReceiversResponse> {
  const params = new URLSearchParams();
  if (from !== undefined) params.set("from", String(from));
  if (to !== undefined) params.set("to", String(to));
  if (sender) params.set("sender", sender);
  if (opts?.rexId && opts.rexId !== "all") params.set("rexId", opts.rexId);

  const query = params.toString();
  const key = `receivers:${from ?? "all"}:${to ?? "all"}:${sender ?? ""}:${opts?.rexId ?? "all"}`;
  const data = await cachedFetch<ReceiversResponse & { ok: boolean }>(
    key,
    query ? `/api/receivers?${query}` : "/api/receivers",
    3000,
    opts
  );
  return {
    groups: data.groups ?? [],
    senders: data.senders ?? [],
    transferCount: data.transferCount ?? 0,
  };
}

export async function fetchReceiverTransfers(
  receiverPhone: string,
  from?: number,
  to?: number,
  sender?: string,
  opts?: { bypassCache?: boolean; noDelay?: boolean; rexId?: string }
): Promise<Transfer[]> {
  const params = new URLSearchParams({ receiver: receiverPhone });
  if (from !== undefined) params.set("from", String(from));
  if (to !== undefined) params.set("to", String(to));
  if (sender) params.set("sender", sender);
  if (opts?.rexId && opts.rexId !== "all") params.set("rexId", opts.rexId);

  const key = `receiverDetail:${receiverPhone}:${from ?? "all"}:${to ?? "all"}:${sender ?? ""}:${opts?.rexId ?? "all"}`;
  const data = await cachedFetch<{ ok: boolean; transfers: Transfer[] }>(
    key,
    `/api/receivers?${params.toString()}`,
    3000,
    { noDelay: true, ...opts }
  );
  return data.transfers ?? [];
}
