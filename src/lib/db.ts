import { query, withTransaction } from "./pg";
import { sse } from "./events";
import { compareNatural, compareOperatorUsers, parseBillExpireDate, phoneSearchKeys } from "./format";
import { decryptSecret, encryptSecret } from "./crypto";
import { DAILY_VOLUME_LIMIT, LOW_BALANCE_THRESHOLD, MONTHLY_VOLUME_LIMIT, TRANSFER_READY_MIN_BALANCE } from "./constants";
import { normalizePermissions, type RolePermissions } from "./permissions";
import type { TransferBalanceFilter, TransferSimCounts } from "./types";

export { DAILY_VOLUME_LIMIT, MONTHLY_VOLUME_LIMIT } from "./constants";

export interface RexGroupRow {
  id: number;
  name: string;
  created_at: number;
  sim_count?: number;
  active_sim_count?: number;
  user_count?: number;
}

export interface RoleRow {
  id: number;
  name: string;
  is_system: boolean;
  permissions: RolePermissions;
  created_at: number;
  updated_at: number;
  user_count?: number;
}

export interface UserRow {
  id: number;
  username: string;
  role_id: number;
  role_name: string;
  rex_id: number | null;
  rex_name: string | null;
  is_active: boolean;
  token_version: number;
  is_env_admin: boolean;
  created_at: number;
  updated_at: number;
}

export interface UserAuthRow extends UserRow {
  password_hash: string;
  permissions: RolePermissions;
}

export interface SimRow {
  id: number;
  phone: string;
  rex_id: number | null;
  rex_name?: string | null;
  added_by_user_id: number | null;
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: number | null;
  refresh_expires_at: number | null;
  subscription_id: string | null;
  balance: number | null;
  balance_checked_at: number | null;
  bill_expire_at: string | null;
  block_one_way: string | null;
  block_two_way: string | null;
  sim_status_text: string | null;
  status: string;
  note: string | null;
  created_at: number;
  updated_at: number;
}

/** A SIM as the API hands it to the browser: no tokens, ever. */
export type PublicSimRow = Omit<SimRow, "access_token" | "refresh_token">;

export interface TransferRow {
  id: number;
  sender_phone: string;
  receiver_phone: string;
  rex_id: number | null;
  rex_name?: string | null;
  created_by_user_id: number | null;
  created_by_username?: string | null;
  amount: number;
  fee: number;
  status: string;
  error_code: number | null;
  message: string | null;
  created_at: number;
}

export interface TransfersFilter {
  fromTs?: number;
  toTs?: number;
  status?: string;
  q?: string;
  rexId?: number | null;
}

export interface SimsPagedQuery {
  rexId?: number | null;
  view?: "all" | "active" | "inactive" | "drained" | "expiring" | "expired";
  q?: string;
  sort?: "recent" | "balance-asc" | "balance-desc" | "expiry-asc";
  page: number;
  pageSize: number;
}

export type Granularity = "hour" | "day";

export interface SeriesBucket {
  ts: number;
  sent: number;
  failed: number;
  volume: number;
}

export interface ReceiverGroup {
  phone: string;
  totalAmount: number;
  totalFee: number;
  successCount: number;
  lastAt: number;
  transfers?: TransferRow[];
}

const TRANSFER_COLUMNS =
  "t.id, t.sender_phone, t.receiver_phone, t.rex_id, rg.name AS rex_name, " +
  "t.created_by_user_id, u.username AS created_by_username, " +
  "t.amount, t.fee, t.status, t.error_code, t.message, t.created_at";

const OUTER_TRANSFER_COLUMNS =
  "r.id, r.sender_phone, r.receiver_phone, r.rex_id, r.rex_name, " +
  "r.created_by_user_id, r.created_by_username, " +
  "r.amount, r.fee, r.status, r.error_code, r.message, r.created_at";

const PUBLIC_SIM_COLUMNS =
  "s.id, s.phone, s.rex_id, rg.name AS rex_name, s.added_by_user_id, " +
  "s.token_expires_at, s.refresh_expires_at, s.subscription_id, s.balance, " +
  "s.balance_checked_at, s.bill_expire_at, s.block_one_way, s.block_two_way, s.sim_status_text, " +
  "s.status, s.note, s.created_at, s.updated_at";

const PAGED_SIM_PROJECTION =
  "p.id, p.phone, p.rex_id, p.rex_name, p.added_by_user_id, " +
  "p.token_expires_at, p.refresh_expires_at, p.subscription_id, p.balance, " +
  "p.balance_checked_at, p.bill_expire_at, p.block_one_way, p.block_two_way, p.sim_status_text, " +
  "p.status, p.note, p.created_at, p.updated_at";

const OUTER_SIM_COLUMNS =
  "r.id, r.phone, r.rex_id, r.rex_name, r.added_by_user_id, " +
  "r.token_expires_at, r.refresh_expires_at, r.subscription_id, r.balance, " +
  "r.balance_checked_at, r.bill_expire_at, r.block_one_way, r.block_two_way, r.sim_status_text, " +
  "r.status, r.note, r.created_at, r.updated_at, r.volume_today, r.volume_this_month";

const TODAY_MM_SQL = `(NOW() AT TIME ZONE 'Asia/Yangon')::date`;
const EXPIRING_SOON_DAYS = 10;

const ENCRYPTED_SIM_COLUMNS = ["access_token", "refresh_token"] as const;
const RECEIVER_GROUP_CAP = 10_000;
const RECEIVER_DETAIL_CAP = 1_000;
const MM_OFFSET_SEC = 6 * 3600 + 30 * 60; // Asia/Yangon UTC+06:30 (no DST)

const SESSION_CACHE_TTL_MS = 10_000;
const SESSION_CACHE_MAX = 256;
const REX_CACHE_TTL_MS = 15_000;

const globalDbCache = globalThis as unknown as {
  __myshareSessionCache?: Map<number, { row: UserAuthRow | null; exp: number }>;
  __myshareRexCache?: { rows: RexGroupRow[]; exp: number } | null;
};

function sessionCacheMap() {
  if (!globalDbCache.__myshareSessionCache) {
    globalDbCache.__myshareSessionCache = new Map();
  }
  return globalDbCache.__myshareSessionCache;
}

function invalidateSessionCache(userId?: number) {
  const cache = sessionCacheMap();
  if (userId !== undefined) {
    cache.delete(userId);
  } else {
    cache.clear();
  }
}

function invalidateRexCache() {
  globalDbCache.__myshareRexCache = null;
}

const now = () => Math.floor(Date.now() / 1000);

/** Typed error for transfer reservation failures; `code`/`httpStatus` drive the API response. */
export class TransferReservationError extends Error {
  constructor(
    message: string,
    readonly code: "sim_not_found" | "daily_volume_limit" | "monthly_volume_limit" | "insufficient_balance",
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "TransferReservationError";
  }
}

function decodeSim<T extends SimRow | undefined>(row: T): T {
  if (!row) return row;
  row.access_token = decryptSecret(row.access_token, row.phone);
  row.refresh_token = decryptSecret(row.refresh_token, row.phone);
  return row;
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (m) => "\\" + m)}%`;
}

function startOfToday(): number {
  const shiftedDay = Math.floor((now() + MM_OFFSET_SEC) / 86400);
  return shiftedDay * 86400 - MM_OFFSET_SEC;
}

function startOfThisMonth(): number {
  const shifted = new Date((now() + MM_OFFSET_SEC) * 1000);
  const firstOfMonthUtc = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1, 0, 0, 0);
  return Math.floor(firstOfMonthUtc / 1000) - MM_OFFSET_SEC;
}

function bucketKey(tsSec: number, granularity: Granularity): string {
  const d = new Date((tsSec + MM_OFFSET_SEC) * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return granularity === "hour" ? `${day}T${p(d.getUTCHours())}` : day;
}

function alignBucketStart(tsSec: number, granularity: Granularity): number {
  if (granularity === "hour") {
    const shifted = tsSec + MM_OFFSET_SEC;
    return Math.floor(shifted / 3600) * 3600 - MM_OFFSET_SEC;
  }
  const shifted = tsSec + MM_OFFSET_SEC;
  return Math.floor(shifted / 86400) * 86400 - MM_OFFSET_SEC;
}

function transfersWhereClause(f: TransfersFilter): { sql: string; args: unknown[] } {
  const clauses: string[] = [];
  const args: unknown[] = [];

  const pushArg = (val: unknown) => {
    args.push(val);
    return `$${args.length}`;
  };

  if (f.rexId !== undefined && f.rexId !== null) {
    clauses.push(`t.rex_id = ${pushArg(f.rexId)}`);
  }
  if (f.fromTs !== undefined) {
    clauses.push(`t.created_at >= ${pushArg(f.fromTs)}`);
  }
  if (f.toTs !== undefined) {
    clauses.push(`t.created_at <= ${pushArg(f.toTs)}`);
  }
  if (f.status) {
    clauses.push(`t.status = ${pushArg(f.status)}`);
  }

  const q = f.q?.trim();
  if (q) {
    const qClean = q.toLowerCase().replace(/[\s-+]/g, "");
    const qLower = q.toLowerCase();

    const ors = [
      `LOWER(COALESCE(t.message, '')) LIKE ${pushArg(likePattern(qLower))} ESCAPE '\\'`,
      `CAST(t.amount AS TEXT) LIKE ${pushArg(likePattern(qClean))} ESCAPE '\\'`,
      `(t.error_code IS NOT NULL AND CAST(t.error_code AS TEXT) LIKE ${pushArg(likePattern(qClean))} ESCAPE '\\')`,
    ];

    for (const key of phoneSearchKeys(q)) {
      const p1 = pushArg(likePattern(key));
      const p2 = pushArg(likePattern(key));
      ors.push(`t.sender_phone LIKE ${p1} ESCAPE '\\'`, `t.receiver_phone LIKE ${p2} ESCAPE '\\'`);
    }

    clauses.push(`(${ors.join(" OR ")})`);
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", args };
}

function mapSimSummaryRow(r: any): PublicSimRow & { volume_today: number; volume_this_month: number } {
  return {
    id: Number(r.id),
    phone: String(r.phone),
    rex_id: r.rex_id === null || r.rex_id === undefined ? null : Number(r.rex_id),
    rex_name: r.rex_name ?? null,
    added_by_user_id:
      r.added_by_user_id === null || r.added_by_user_id === undefined ? null : Number(r.added_by_user_id),
    token_expires_at:
      r.token_expires_at === null || r.token_expires_at === undefined ? null : Number(r.token_expires_at),
    refresh_expires_at:
      r.refresh_expires_at === null || r.refresh_expires_at === undefined ? null : Number(r.refresh_expires_at),
    subscription_id: r.subscription_id ?? null,
    balance: r.balance === null || r.balance === undefined ? null : Number(r.balance),
    balance_checked_at:
      r.balance_checked_at === null || r.balance_checked_at === undefined ? null : Number(r.balance_checked_at),
    bill_expire_at: r.bill_expire_at ?? null,
    block_one_way: r.block_one_way ?? null,
    block_two_way: r.block_two_way ?? null,
    sim_status_text: r.sim_status_text ?? null,
    status: String(r.status),
    note: r.note ?? null,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
    volume_today: Number(r.volume_today ?? 0),
    volume_this_month: Number(r.volume_this_month ?? 0),
  };
}

function mapTransferRow(r: any): TransferRow {
  return {
    id: Number(r.id),
    sender_phone: String(r.sender_phone),
    receiver_phone: String(r.receiver_phone),
    rex_id: r.rex_id === null || r.rex_id === undefined ? null : Number(r.rex_id),
    rex_name: r.rex_name ?? null,
    created_by_user_id:
      r.created_by_user_id === null || r.created_by_user_id === undefined ? null : Number(r.created_by_user_id),
    created_by_username: r.created_by_username ?? null,
    amount: Number(r.amount),
    fee: Number(r.fee),
    status: String(r.status),
    error_code: r.error_code === null || r.error_code === undefined ? null : Number(r.error_code),
    message: r.message ?? null,
    created_at: Number(r.created_at),
  };
}

function mapUserRow(row: any): UserAuthRow {
  const roleName = String(row.role_name ?? "Staff");
  const isAdminRole = roleName.toLowerCase() === "admin";
  return {
    id: Number(row.id),
    username: String(row.username),
    password_hash: String(row.password_hash ?? ""),
    role_id: Number(row.role_id),
    role_name: roleName,
    rex_id: row.rex_id === null || row.rex_id === undefined ? null : Number(row.rex_id),
    rex_name: row.rex_name ? String(row.rex_name) : null,
    is_active: Boolean(row.is_active),
    token_version: Number(row.token_version),
    is_env_admin: Boolean(row.is_env_admin),
    permissions: normalizePermissions(row.permissions, undefined),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export const dbApi = {
  // ---- Auth, Users, Roles & Rex Groups -------------------------------------

  async getUserAuthByUsername(username: string): Promise<UserAuthRow | undefined> {
    const res = await query(
      `SELECT u.*, r.name AS role_name, r.permissions, rg.name AS rex_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN rex_groups rg ON rg.id = u.rex_id
       WHERE u.username_lower = $1
       LIMIT 1`,
      [username.trim().toLowerCase()]
    );
    if (!res.rows[0]) return undefined;
    return mapUserRow(res.rows[0]);
  },

  async getUserSessionById(userId: number): Promise<UserAuthRow | undefined> {
    const cache = sessionCacheMap();
    const nowMs = Date.now();
    const hit = cache.get(userId);
    if (hit && hit.exp > nowMs) {
      return hit.row ?? undefined;
    }

    const res = await query(
      `SELECT u.*, r.name AS role_name, r.permissions, rg.name AS rex_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN rex_groups rg ON rg.id = u.rex_id
       WHERE u.id = $1
       LIMIT 1`,
      [userId]
    );
    const mapped = res.rows[0] ? mapUserRow(res.rows[0]) : null;
    if (cache.size >= SESSION_CACHE_MAX) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    cache.set(userId, { row: mapped, exp: nowMs + SESSION_CACHE_TTL_MS });
    return mapped ?? undefined;
  },

  async listUsers(): Promise<UserRow[]> {
    const res = await query(
      `SELECT u.id, u.username, u.role_id, r.name AS role_name, u.rex_id, rg.name AS rex_name,
              u.is_active, u.token_version, u.is_env_admin, u.created_at, u.updated_at
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN rex_groups rg ON rg.id = u.rex_id
       ORDER BY u.is_env_admin DESC, u.id ASC`
    );
    const rows = res.rows.map((r) => ({
      id: Number(r.id),
      username: String(r.username),
      role_id: Number(r.role_id),
      role_name: String(r.role_name),
      rex_id: r.rex_id === null ? null : Number(r.rex_id),
      rex_name: r.rex_name ?? null,
      is_active: Boolean(r.is_active),
      token_version: Number(r.token_version),
      is_env_admin: Boolean(r.is_env_admin),
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
    }));
    rows.sort(compareOperatorUsers);
    return rows;
  },

  async createUser(input: {
    username: string;
    passwordHash: string;
    roleId: number;
    rexId: number | null;
  }): Promise<UserRow> {
    const ts = now();
    const cleanName = input.username.trim();
    const res = await query<{ id: number }>(
      `INSERT INTO users (username, username_lower, password_hash, role_id, rex_id, is_active, is_env_admin, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, TRUE, FALSE, $6, $6)
       RETURNING id`,
      [cleanName, cleanName.toLowerCase(), input.passwordHash, input.roleId, input.rexId, ts]
    );
    invalidateRexCache();
    invalidateSessionCache(res.rows[0].id);
    const created = await this.getUserSessionById(res.rows[0].id);
    return created!;
  },

  async updateUser(
    id: number,
    fields: {
      username?: string;
      passwordHash?: string;
      roleId?: number;
      rexId?: number | null;
      isActive?: boolean;
      bumpTokenVersion?: boolean;
    }
  ): Promise<UserRow | undefined> {
    const sets: string[] = [];
    const args: unknown[] = [];
    const push = (v: unknown) => {
      args.push(v);
      return `$${args.length}`;
    };

    if (fields.username !== undefined) {
      const clean = fields.username.trim();
      sets.push(`username = ${push(clean)}`);
      sets.push(`username_lower = ${push(clean.toLowerCase())}`);
    }
    if (fields.passwordHash !== undefined) {
      sets.push(`password_hash = ${push(fields.passwordHash)}`);
    }
    if (fields.roleId !== undefined) {
      sets.push(`role_id = ${push(fields.roleId)}`);
    }
    if (fields.rexId !== undefined) {
      sets.push(`rex_id = ${push(fields.rexId)}`);
    }
    if (fields.isActive !== undefined) {
      sets.push(`is_active = ${push(fields.isActive)}`);
    }
    if (fields.bumpTokenVersion || fields.passwordHash !== undefined || fields.isActive === false) {
      sets.push("token_version = token_version + 1");
    }
    if (sets.length === 0) return this.getUserSessionById(id);

    sets.push(`updated_at = ${push(now())}`);
    const idParam = push(id);
    await query(`UPDATE users SET ${sets.join(", ")} WHERE id = ${idParam}`, args);
    invalidateSessionCache(id);
    invalidateRexCache();
    return this.getUserSessionById(id);
  },

  async deleteUser(id: number): Promise<boolean> {
    const res = await query(`DELETE FROM users WHERE id = $1 AND is_env_admin = FALSE`, [id]);
    const deleted = (res.rowCount ?? 0) > 0;
    if (deleted) {
      invalidateSessionCache(id);
      invalidateRexCache();
    }
    return deleted;
  },

  async listRoles(): Promise<RoleRow[]> {
    const res = await query(
      `SELECT r.*, COUNT(u.id)::int AS user_count
       FROM roles r
       LEFT JOIN users u ON u.role_id = r.id
       GROUP BY r.id
       ORDER BY r.is_system DESC, r.id ASC`
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      is_system: Boolean(r.is_system),
      permissions: normalizePermissions(r.permissions),
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
      user_count: Number(r.user_count ?? 0),
    }));
  },

  async getRoleById(id: number): Promise<RoleRow | undefined> {
    const res = await query(`SELECT * FROM roles WHERE id = $1 LIMIT 1`, [id]);
    const r = res.rows[0];
    if (!r) return undefined;
    return {
      id: Number(r.id),
      name: String(r.name),
      is_system: Boolean(r.is_system),
      permissions: normalizePermissions(r.permissions),
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
    };
  },

  async createRole(name: string, permissions: RolePermissions): Promise<RoleRow> {
    const clean = name.trim();
    const ts = now();
    const norm = normalizePermissions(permissions);
    const res = await query<{ id: number }>(
      `INSERT INTO roles (name, name_lower, is_system, permissions, created_at, updated_at)
       VALUES ($1, $2, FALSE, $3::jsonb, $4, $4)
       RETURNING id`,
      [clean, clean.toLowerCase(), JSON.stringify(norm), ts]
    );
    return (await this.getRoleById(res.rows[0].id))!;
  },

  async updateRole(
    id: number,
    fields: { name?: string; permissions?: RolePermissions }
  ): Promise<RoleRow | undefined> {
    const existing = await this.getRoleById(id);
    if (!existing) return undefined;
    const sets: string[] = [];
    const args: unknown[] = [];
    const push = (v: unknown) => {
      args.push(v);
      return `$${args.length}`;
    };

    if (fields.name !== undefined && !existing.is_system) {
      const clean = fields.name.trim();
      sets.push(`name = ${push(clean)}`);
      sets.push(`name_lower = ${push(clean.toLowerCase())}`);
    }
    if (fields.permissions !== undefined) {
      const norm = normalizePermissions(fields.permissions);
      sets.push(`permissions = ${push(JSON.stringify(norm))}::jsonb`);
    }
    if (sets.length === 0) return existing;
    sets.push(`updated_at = ${push(now())}`);
    const idParam = push(id);
    await query(`UPDATE roles SET ${sets.join(", ")} WHERE id = ${idParam}`, args);
    invalidateSessionCache();
    return this.getRoleById(id);
  },

  async deleteRole(id: number): Promise<{ deleted: boolean; reason?: string }> {
    const role = await this.getRoleById(id);
    if (!role) return { deleted: false, reason: "Role not found" };
    if (role.is_system) return { deleted: false, reason: "System roles cannot be deleted" };
    const used = await query<{ c: number }>(`SELECT COUNT(*)::int AS c FROM users WHERE role_id = $1`, [id]);
    if ((used.rows[0]?.c ?? 0) > 0) {
      return { deleted: false, reason: "Role is currently assigned to users" };
    }
    await query(`DELETE FROM roles WHERE id = $1`, [id]);
    invalidateSessionCache();
    return { deleted: true };
  },

  async listRexGroups(): Promise<RexGroupRow[]> {
    const cached = globalDbCache.__myshareRexCache;
    const nowMs = Date.now();
    if (cached && cached.exp > nowMs) {
      return cached.rows.map((r) => ({ ...r }));
    }

    const res = await query(
      `WITH sim_agg AS (
         SELECT rex_id,
                COUNT(*)::int AS sim_count,
                COUNT(*) FILTER (WHERE status = 'active')::int AS active_sim_count
         FROM sims
         WHERE rex_id IS NOT NULL
         GROUP BY rex_id
       ),
       user_agg AS (
         SELECT rex_id, COUNT(*)::int AS user_count
         FROM users
         WHERE rex_id IS NOT NULL
         GROUP BY rex_id
       )
       SELECT rg.id, rg.name, rg.created_at,
              COALESCE(sa.sim_count, 0)::int AS sim_count,
              COALESCE(sa.active_sim_count, 0)::int AS active_sim_count,
              COALESCE(ua.user_count, 0)::int AS user_count
       FROM rex_groups rg
       LEFT JOIN sim_agg sa ON sa.rex_id = rg.id
       LEFT JOIN user_agg ua ON ua.rex_id = rg.id
       ORDER BY rg.id ASC`
    );
    const rows = res.rows.map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      created_at: Number(r.created_at),
      sim_count: Number(r.sim_count ?? 0),
      active_sim_count: Number(r.active_sim_count ?? 0),
      user_count: Number(r.user_count ?? 0),
    }));
    rows.sort((a, b) => compareNatural(a.name, b.name));
    globalDbCache.__myshareRexCache = { rows, exp: nowMs + REX_CACHE_TTL_MS };
    return rows.map((r) => ({ ...r }));
  },

  async getRexGroupById(id: number): Promise<RexGroupRow | undefined> {
    const res = await query(`SELECT id, name, created_at FROM rex_groups WHERE id = $1 LIMIT 1`, [id]);
    const r = res.rows[0];
    return r ? { id: Number(r.id), name: String(r.name), created_at: Number(r.created_at) } : undefined;
  },

  async getRexGroupByName(name: string): Promise<RexGroupRow | undefined> {
    const res = await query(`SELECT id, name, created_at FROM rex_groups WHERE name_lower = $1 LIMIT 1`, [
      name.trim().toLowerCase(),
    ]);
    const r = res.rows[0];
    return r ? { id: Number(r.id), name: String(r.name), created_at: Number(r.created_at) } : undefined;
  },

  async createRexGroup(name: string): Promise<RexGroupRow> {
    const clean = name.trim();
    const res = await query<RexGroupRow>(
      `INSERT INTO rex_groups (name, name_lower, created_at)
       VALUES ($1, $2, $3)
       RETURNING id, name, created_at`,
      [clean, clean.toLowerCase(), now()]
    );
    invalidateRexCache();
    return res.rows[0];
  },

  async renameRexGroup(id: number, name: string): Promise<RexGroupRow | undefined> {
    const clean = name.trim();
    const res = await query<RexGroupRow>(
      `UPDATE rex_groups SET name = $1, name_lower = $2 WHERE id = $3 RETURNING id, name, created_at`,
      [clean, clean.toLowerCase(), id]
    );
    invalidateRexCache();
    invalidateSessionCache();
    return res.rows[0];
  },

  async deleteRexGroup(
    id: number
  ): Promise<{ deleted: boolean; status?: number; reason?: string; name?: string }> {
    const result = await withTransaction(async (client) => {
      const rowRes = await client.query<{ id: number; name: string }>(
        `SELECT id, name FROM rex_groups WHERE id = $1 FOR UPDATE`,
        [id]
      );
      const rex = rowRes.rows[0];
      if (!rex) {
        return { deleted: false, status: 404, reason: "Rex category not found" };
      }

      const counts = await client.query<{ users: number; sims: number }>(
        `SELECT
           (SELECT COUNT(*)::int FROM users WHERE rex_id = $1) AS users,
           (SELECT COUNT(*)::int FROM sims WHERE rex_id = $1) AS sims`,
        [id]
      );
      const { users, sims } = counts.rows[0];
      if (users > 0 || sims > 0) {
        return {
          deleted: false,
          status: 409,
          reason: `Cannot delete "${rex.name}": ${users} user(s) and ${sims} SIM(s) are still assigned`,
        };
      }

      await client.query(`DELETE FROM rex_groups WHERE id = $1`, [id]);
      return { deleted: true, name: rex.name };
    });
    if (result.deleted) {
      invalidateRexCache();
    }
    return result;
  },

  async addAuditLog(entry: {
    actorUserId: number | null;
    actorUsername: string;
    action: string;
    targetType: string;
    targetId?: string | null;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    await query(
      `INSERT INTO audit_logs (actor_user_id, actor_username, action, target_type, target_id, detail, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        entry.actorUserId,
        entry.actorUsername,
        entry.action,
        entry.targetType,
        entry.targetId ?? null,
        entry.detail ? JSON.stringify(entry.detail) : null,
        now(),
      ]
    );
  },

  // ---- SIMs ----------------------------------------------------------------

  async getTransferById(id: number): Promise<TransferRow | undefined> {
    const res = await query<TransferRow>(
      `SELECT ${TRANSFER_COLUMNS}
       FROM transfers t
       LEFT JOIN rex_groups rg ON rg.id = t.rex_id
       LEFT JOIN users u ON u.id = t.created_by_user_id
       WHERE t.id = $1 LIMIT 1`,
      [id]
    );
    return res.rows[0];
  },

  async fleetCounts(rexId?: number | null): Promise<{ total: number; active: number }> {
    const args: unknown[] = [];
    const where = rexId !== undefined && rexId !== null ? `WHERE rex_id = $1` : "";
    if (rexId !== undefined && rexId !== null) args.push(rexId);
    const res = await query<{ total: number; active: number }>(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'active')::int AS active
       FROM sims
       ${where}`,
      args
    );
    const row = res.rows[0];
    return { total: Number(row?.total ?? 0), active: Number(row?.active ?? 0) };
  },

  async listSimsPublic(opts?: {
    rexId?: number | null;
    status?: string;
    balanceFilter?: TransferBalanceFilter;
    q?: string;
    includePhone?: string;
    limit?: number;
  }): Promise<{
    sims: (PublicSimRow & { volume_today: number; volume_this_month: number })[];
    total: number;
    activeTotal: number;
    counts: TransferSimCounts;
  }> {
    const args: unknown[] = [];
    const push = (v: unknown) => {
      args.push(v);
      return `$${args.length}`;
    };

    const rexParam = opts?.rexId !== undefined && opts.rexId !== null ? push(opts.rexId) : null;
    const scopeWhere = rexParam ? `WHERE s.rex_id = ${rexParam}` : "";
    const mvRexClause = rexParam ? `AND t.rex_id = ${rexParam}` : "";
    const readyMinParam = push(TRANSFER_READY_MIN_BALANCE);

    const balanceFilter: TransferBalanceFilter =
      opts?.balanceFilter === "ready" || opts?.balanceFilter === "low" ? opts.balanceFilter : "all";

    const clauses: string[] = rexParam ? [`s.rex_id = ${rexParam}`] : [];
    if (opts?.status) {
      clauses.push(`s.status = ${push(opts.status)}`);
    }

    if (balanceFilter === "ready") {
      clauses.push(`s.status = 'active' AND s.balance IS NOT NULL AND s.balance >= ${readyMinParam}`);
    } else if (balanceFilter === "low") {
      clauses.push(`s.status = 'active' AND s.balance IS NOT NULL AND s.balance < ${readyMinParam}`);
    }

    const searchRaw = opts?.q?.trim();
    if (searchRaw) {
      const ors: string[] = [
        `LOWER(COALESCE(s.note, '')) LIKE ${push(likePattern(searchRaw.toLowerCase()))} ESCAPE '\\'`,
      ];
      for (const key of phoneSearchKeys(searchRaw)) {
        ors.push(`s.phone LIKE ${push(likePattern(key))} ESCAPE '\\'`);
      }
      clauses.push(`(${ors.join(" OR ")})`);
    }

    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const needsFilteredCount = Boolean(opts?.status || searchRaw);

    const monthStartSec = startOfThisMonth();
    const todayStartSec = startOfToday();
    const monthStartParam = push(monthStartSec);
    const todayStartParam = push(todayStartSec);
    const headroomAmt = balanceFilter === "ready" ? 5000 : 500;
    const dailyHeadroomParam = push(DAILY_VOLUME_LIMIT - headroomAmt);
    const monthlyHeadroomParam = push(MONTHLY_VOLUME_LIMIT - headroomAmt);
    const dailyCapParam = push(DAILY_VOLUME_LIMIT);
    const monthlyCapParam = push(MONTHLY_VOLUME_LIMIT);
    const limitVal = Math.max(1, Math.min(2000, opts?.limit ?? 48));
    const limitParam = push(limitVal);

    const res = await query<any>(
      `WITH scope_counts AS (
         SELECT
           COUNT(*)::int AS _cnt_all,
           COUNT(*) FILTER (WHERE s.status = 'active')::int AS _cnt_active_total,
           COUNT(*) FILTER (WHERE s.status = 'active' AND s.balance IS NOT NULL AND s.balance >= ${readyMinParam})::int AS _cnt_ready,
           COUNT(*) FILTER (WHERE s.status = 'active' AND s.balance IS NOT NULL AND s.balance < ${readyMinParam})::int AS _cnt_low
         FROM sims s
         ${scopeWhere}
       ),
       ${needsFilteredCount ? `filtered_total AS (SELECT COUNT(*)::int AS _filtered_total FROM sims s ${where}),` : ""}
       month_vol AS (
         SELECT t.sender_phone,
                COALESCE(SUM(t.amount) FILTER (WHERE t.created_at >= ${todayStartParam}), 0)::bigint AS vol_today,
                COALESCE(SUM(t.amount), 0)::bigint AS vol_month
         FROM transfers t
         WHERE t.status = 'success' AND t.created_at >= ${monthStartParam} ${mvRexClause}
         GROUP BY t.sender_phone
       ),
       rows_out AS (
         SELECT ${PUBLIC_SIM_COLUMNS},
                COALESCE(mv.vol_today, 0)::bigint AS volume_today,
                COALESCE(mv.vol_month, 0)::bigint AS volume_this_month,
                ROW_NUMBER() OVER (
                  ORDER BY
                    CASE WHEN s.status = 'active' THEN 0 ELSE 1 END ASC,
                    CASE
                      WHEN s.status = 'active'
                       AND COALESCE(mv.vol_today, 0) <= ${dailyHeadroomParam}
                       AND COALESCE(mv.vol_month, 0) <= ${monthlyHeadroomParam}
                      THEN 0
                      WHEN s.status = 'active'
                       AND COALESCE(mv.vol_today, 0) < ${dailyCapParam}
                       AND COALESCE(mv.vol_month, 0) < ${monthlyCapParam}
                      THEN 1
                      ELSE 2
                    END ASC,
                    s.updated_at DESC,
                    s.id DESC
                ) AS _ord
         FROM sims s
         LEFT JOIN rex_groups rg ON rg.id = s.rex_id
         LEFT JOIN month_vol mv ON mv.sender_phone = s.phone
         ${where}
         ORDER BY
           CASE WHEN s.status = 'active' THEN 0 ELSE 1 END ASC,
           CASE
             WHEN s.status = 'active'
              AND COALESCE(mv.vol_today, 0) <= ${dailyHeadroomParam}
              AND COALESCE(mv.vol_month, 0) <= ${monthlyHeadroomParam}
             THEN 0
             WHEN s.status = 'active'
              AND COALESCE(mv.vol_today, 0) < ${dailyCapParam}
              AND COALESCE(mv.vol_month, 0) < ${monthlyCapParam}
             THEN 1
             ELSE 2
           END ASC,
           s.updated_at DESC,
           s.id DESC
         LIMIT ${limitParam}
       )
       SELECT
         sc._cnt_all,
         sc._cnt_active_total,
         sc._cnt_ready,
         sc._cnt_low,
         ${needsFilteredCount ? "ft._filtered_total" : "NULL::int AS _filtered_total"},
         ${OUTER_SIM_COLUMNS}
       FROM scope_counts sc
       ${needsFilteredCount ? "CROSS JOIN filtered_total ft" : ""}
       LEFT JOIN rows_out r ON TRUE
       ORDER BY r._ord ASC NULLS LAST`,
      args
    );

    const sims = res.rows.filter((r) => r.id !== null).map(mapSimSummaryRow);
    const includePhone = opts?.includePhone?.trim();
    if (includePhone && !sims.some((s) => s.phone === includePhone)) {
      const incArgs: unknown[] = [includePhone];
      const incClauses: string[] = [`s.phone = $1`];
      const pushInc = (v: unknown) => {
        incArgs.push(v);
        return `$${incArgs.length}`;
      };
      if (opts?.rexId !== undefined && opts.rexId !== null) {
        incClauses.push(`s.rex_id = ${pushInc(opts.rexId)}`);
      }
      if (balanceFilter === "ready") {
        incClauses.push(`s.status = 'active' AND s.balance IS NOT NULL AND s.balance >= ${pushInc(TRANSFER_READY_MIN_BALANCE)}`);
      } else if (balanceFilter === "low") {
        incClauses.push(`s.status = 'active' AND s.balance IS NOT NULL AND s.balance < ${pushInc(TRANSFER_READY_MIN_BALANCE)}`);
      }
      const incMonthParam = pushInc(monthStartSec);
      const incTodayParam = pushInc(todayStartSec);
      const incMvRexClause =
        opts?.rexId !== undefined && opts.rexId !== null ? `AND t.rex_id = ${pushInc(opts.rexId)}` : "";
      const incRes = await query<PublicSimRow & { volume_today: number; volume_this_month: number }>(
        `SELECT ${PUBLIC_SIM_COLUMNS},
                COALESCE(v.vol_today, 0)::bigint AS volume_today,
                COALESCE(v.vol_month, 0)::bigint AS volume_this_month
         FROM sims s
         LEFT JOIN rex_groups rg ON rg.id = s.rex_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(t.amount) FILTER (WHERE t.created_at >= ${incTodayParam}), 0)::bigint AS vol_today,
                  COALESCE(SUM(t.amount), 0)::bigint AS vol_month
           FROM transfers t
           WHERE t.status = 'success' AND t.created_at >= ${incMonthParam} AND t.sender_phone = s.phone ${incMvRexClause}
         ) v ON TRUE
         WHERE ${incClauses.join(" AND ")}
         LIMIT 1`,
        incArgs
      );
      if (incRes.rows[0]) {
        sims.unshift(mapSimSummaryRow(incRes.rows[0]));
      }
    }

    const first = res.rows[0];
    const counts: TransferSimCounts = {
      all: Number(first?._cnt_all ?? 0),
      ready: Number(first?._cnt_ready ?? 0),
      low: Number(first?._cnt_low ?? 0),
    };
    const total = needsFilteredCount
      ? Number(first?._filtered_total ?? sims.length)
      : balanceFilter === "ready"
        ? counts.ready
        : balanceFilter === "low"
          ? counts.low
          : counts.all;

    return {
      sims,
      total,
      activeTotal: Number(first?._cnt_active_total ?? 0),
      counts,
    };
  },

  async listSimsPaged(q: SimsPagedQuery): Promise<{
    sims: (PublicSimRow & { volume_today: number; volume_this_month: number })[];
    total: number;
    counts: {
      all: number;
      active: number;
      inactive: number;
      drained: number;
      expiring: number;
      expired: number;
    };
  }> {
    const args: unknown[] = [];
    const push = (v: unknown) => {
      args.push(v);
      return `$${args.length}`;
    };

    const rexParam = q.rexId !== undefined && q.rexId !== null ? push(q.rexId) : null;
    const scopeWhere = rexParam ? `WHERE s.rex_id = ${rexParam}` : "";
    const lowParam = push(LOW_BALANCE_THRESHOLD);
    const daysParam = push(EXPIRING_SOON_DAYS);

    const clauses: string[] = rexParam ? [`s.rex_id = ${rexParam}`] : [];
    let viewKey: "all" | "active" | "inactive" | "drained" | "expiring" | "expired" = "all";

    if (q.view === "active") {
      viewKey = "active";
      clauses.push(`s.status = 'active'`);
    } else if (q.view === "inactive") {
      viewKey = "inactive";
      clauses.push(`s.status <> 'active'`);
    } else if (q.view === "drained") {
      viewKey = "drained";
      clauses.push(`s.status = 'active' AND s.balance IS NOT NULL AND s.balance < ${lowParam}`);
    } else if (q.view === "expiring") {
      viewKey = "expiring";
      clauses.push(
        `s.bill_expire_date IS NOT NULL AND s.bill_expire_date > ${TODAY_MM_SQL} AND (s.bill_expire_date - ${TODAY_MM_SQL}) <= ${daysParam}`
      );
    } else if (q.view === "expired") {
      viewKey = "expired";
      clauses.push(`s.bill_expire_date IS NOT NULL AND s.bill_expire_date <= ${TODAY_MM_SQL}`);
    }

    const searchRaw = q.q?.trim();
    if (searchRaw) {
      const qLower = searchRaw.toLowerCase();
      const ors: string[] = [
        `LOWER(COALESCE(s.note, '')) LIKE ${push(likePattern(qLower))} ESCAPE '\\'`,
        `LOWER(COALESCE(rg.name, '')) LIKE ${push(likePattern(qLower))} ESCAPE '\\'`,
      ];
      for (const key of phoneSearchKeys(searchRaw)) {
        ors.push(`s.phone LIKE ${push(likePattern(key))} ESCAPE '\\'`);
      }
      clauses.push(`(${ors.join(" OR ")})`);
    }

    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const needsFilteredCount = Boolean(searchRaw);

    let orderSql = "s.updated_at DESC, s.id DESC";
    if (q.sort === "balance-asc") {
      orderSql = "CASE WHEN s.balance IS NULL THEN 1 ELSE 0 END ASC, s.balance ASC, s.updated_at DESC";
    } else if (q.sort === "balance-desc") {
      orderSql = "CASE WHEN s.balance IS NULL THEN 1 ELSE 0 END ASC, s.balance DESC, s.updated_at DESC";
    } else if (q.sort === "expiry-asc") {
      orderSql = "CASE WHEN s.bill_expire_date IS NULL THEN 1 ELSE 0 END ASC, s.bill_expire_date ASC, s.updated_at DESC";
    }

    const limitParam = push(q.pageSize);
    const offsetParam = push((Math.max(1, q.page) - 1) * q.pageSize);
    const monthStartParam = push(startOfThisMonth());
    const todayStartParam = push(startOfToday());

    const res = await query<any>(
      `WITH scope_counts AS (
         SELECT
           COUNT(*)::int AS _cnt_all,
           COUNT(*) FILTER (WHERE s.status = 'active')::int AS _cnt_active,
           COUNT(*) FILTER (WHERE s.status <> 'active')::int AS _cnt_inactive,
           COUNT(*) FILTER (WHERE s.status = 'active' AND s.balance IS NOT NULL AND s.balance < ${lowParam})::int AS _cnt_drained,
           COUNT(*) FILTER (WHERE s.bill_expire_date IS NOT NULL AND s.bill_expire_date > ${TODAY_MM_SQL} AND (s.bill_expire_date - ${TODAY_MM_SQL}) <= ${daysParam})::int AS _cnt_expiring,
           COUNT(*) FILTER (WHERE s.bill_expire_date IS NOT NULL AND s.bill_expire_date <= ${TODAY_MM_SQL})::int AS _cnt_expired
         FROM sims s
         ${scopeWhere}
       ),
       ${needsFilteredCount ? `filtered_total AS (
         SELECT COUNT(*)::int AS _filtered_total
         FROM sims s
         LEFT JOIN rex_groups rg ON rg.id = s.rex_id
         ${whereSql}
       ),` : ""}
       paged AS (
         SELECT ${PUBLIC_SIM_COLUMNS},
                ROW_NUMBER() OVER (ORDER BY ${orderSql}) AS _ord
         FROM sims s
         LEFT JOIN rex_groups rg ON rg.id = s.rex_id
         ${whereSql}
         ORDER BY ${orderSql}
         LIMIT ${limitParam} OFFSET ${offsetParam}
       ),
       rows_out AS (
         SELECT ${PAGED_SIM_PROJECTION},
                p._ord,
                COALESCE(v.vol_today, 0)::bigint AS volume_today,
                COALESCE(v.vol_month, 0)::bigint AS volume_this_month
         FROM paged p
         LEFT JOIN LATERAL (
           SELECT COALESCE(SUM(t.amount) FILTER (WHERE t.created_at >= ${todayStartParam}), 0)::bigint AS vol_today,
                  COALESCE(SUM(t.amount), 0)::bigint AS vol_month
           FROM transfers t
           WHERE t.status = 'success' AND t.created_at >= ${monthStartParam} AND t.sender_phone = p.phone
         ) v ON TRUE
       )
       SELECT
         sc._cnt_all,
         sc._cnt_active,
         sc._cnt_inactive,
         sc._cnt_drained,
         sc._cnt_expiring,
         sc._cnt_expired,
         ${needsFilteredCount ? "ft._filtered_total" : "NULL::int AS _filtered_total"},
         ${OUTER_SIM_COLUMNS}
       FROM scope_counts sc
       ${needsFilteredCount ? "CROSS JOIN filtered_total ft" : ""}
       LEFT JOIN rows_out r ON TRUE
       ORDER BY r._ord ASC NULLS LAST`,
      args
    );

    const first = res.rows[0];
    const counts = {
      all: Number(first?._cnt_all ?? 0),
      active: Number(first?._cnt_active ?? 0),
      inactive: Number(first?._cnt_inactive ?? 0),
      drained: Number(first?._cnt_drained ?? 0),
      expiring: Number(first?._cnt_expiring ?? 0),
      expired: Number(first?._cnt_expired ?? 0),
    };
    const total = needsFilteredCount ? Number(first?._filtered_total ?? 0) : counts[viewKey];

    return {
      sims: res.rows.filter((r) => r.id !== null).map(mapSimSummaryRow),
      total,
      counts,
    };
  },

  async getSim(phone: string): Promise<SimRow | undefined> {
    const res = await query<SimRow>(
      `SELECT s.*, rg.name AS rex_name
       FROM sims s
       LEFT JOIN rex_groups rg ON rg.id = s.rex_id
       WHERE s.phone = $1 LIMIT 1`,
      [phone]
    );
    return decodeSim(res.rows[0]);
  },

  async getSimById(id: number): Promise<SimRow | undefined> {
    const res = await query<SimRow>(
      `SELECT s.*, rg.name AS rex_name
       FROM sims s
       LEFT JOIN rex_groups rg ON rg.id = s.rex_id
       WHERE s.id = $1 LIMIT 1`,
      [id]
    );
    return decodeSim(res.rows[0]);
  },

  async upsertSim(phone: string, fields: Partial<SimRow>): Promise<SimRow> {
    const ts = now();
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO sims (phone, created_at, updated_at)
         VALUES ($1, $2, $2)
         ON CONFLICT (phone) DO NOTHING`,
        [phone, ts]
      );

      const sets: string[] = [];
      const vals: unknown[] = [];
      const push = (v: unknown) => {
        vals.push(v);
        return `$${vals.length}`;
      };

      const skipKeys = new Set(["phone", "id", "rex_name", "created_at", "bill_expire_date"]);
      for (const [k, v] of Object.entries(fields)) {
        if (skipKeys.has(k) || v === undefined) continue;
        const val = ENCRYPTED_SIM_COLUMNS.includes(k as (typeof ENCRYPTED_SIM_COLUMNS)[number])
          ? encryptSecret(v as string | null, phone)
          : v;
        sets.push(`${k} = ${push(val)}`);
      }
      if (fields.bill_expire_at !== undefined) {
        sets.push(`bill_expire_date = ${push(parseBillExpireDate(fields.bill_expire_at))}`);
      }
      if (sets.length > 0) {
        sets.push(`updated_at = ${push(ts)}`);
        const pPhone = push(phone);
        await client.query(`UPDATE sims SET ${sets.join(", ")} WHERE phone = ${pPhone}`, vals);
      }
    });

    invalidateRexCache();
    const updated = (await this.getSim(phone))!;
    sse.emit("update", { kind: "sync", scope: "sims", rexId: updated.rex_id });
    return updated;
  },

  async moveSimsToRex(phones: string[], targetRexId: number | null): Promise<number> {
    if (phones.length === 0) return 0;
    const prevRexRes = await query<{ rex_id: number | null }>(
      `SELECT DISTINCT rex_id FROM sims WHERE phone = ANY($1::text[])`,
      [phones]
    );
    const res = await query(
      `UPDATE sims SET rex_id = $1, updated_at = $2 WHERE phone = ANY($3::text[])`,
      [targetRexId, now(), phones]
    );
    const moved = res.rowCount ?? 0;
    if (moved > 0) {
      invalidateRexCache();
      const notified = new Set<number | null>();
      for (const r of prevRexRes.rows) notified.add(r.rex_id);
      notified.add(targetRexId);
      for (const rexId of notified) {
        sse.emit("update", { kind: "sync", scope: "sims", rexId });
      }
    }
    return moved;
  },

  async deleteSims(phones: string[], scopedRexId?: number | null): Promise<number> {
    if (phones.length === 0) return 0;
    const rexRes = await query<{ rex_id: number | null }>(
      scopedRexId != null
        ? `SELECT DISTINCT rex_id FROM sims WHERE phone = ANY($1::text[]) AND rex_id = $2`
        : `SELECT DISTINCT rex_id FROM sims WHERE phone = ANY($1::text[])`,
      scopedRexId != null ? [phones, scopedRexId] : [phones]
    );
    const delRes = await query(
      scopedRexId != null
        ? `DELETE FROM sims WHERE phone = ANY($1::text[]) AND rex_id = $2`
        : `DELETE FROM sims WHERE phone = ANY($1::text[])`,
      scopedRexId != null ? [phones, scopedRexId] : [phones]
    );
    const removed = delRes.rowCount ?? 0;
    if (removed > 0) {
      invalidateRexCache();
      for (const r of rexRes.rows) {
        sse.emit("update", { kind: "sync", scope: "sims", rexId: r.rex_id });
      }
    }
    return removed;
  },

  async debitSimBalance(phone: string, amount: number): Promise<void> {
    const res = await query<{ rex_id: number | null }>(
      `UPDATE sims SET balance = GREATEST(0, balance - $1), updated_at = $2
       WHERE phone = $3 AND balance IS NOT NULL
       RETURNING rex_id`,
      [amount, now(), phone]
    );
    if ((res.rowCount ?? 0) > 0) {
      sse.emit("update", { kind: "sync", scope: "sim_balance", rexId: res.rows[0].rex_id });
    }
  },

  // ---- Transfers -----------------------------------------------------------

  async addTransfer(t: {
    sender_phone: string;
    receiver_phone: string;
    rex_id?: number | null;
    created_by_user_id?: number | null;
    amount: number;
    fee: number;
    status: string;
    error_code?: number | null;
    message?: string | null;
  }): Promise<TransferRow> {
    const ts = now();
    const res = await query<{ id: number }>(
      `INSERT INTO transfers (sender_phone, receiver_phone, rex_id, created_by_user_id, amount, fee, status, error_code, message, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        t.sender_phone,
        t.receiver_phone,
        t.rex_id ?? null,
        t.created_by_user_id ?? null,
        t.amount,
        t.fee,
        t.status,
        t.error_code ?? null,
        t.message ?? null,
        ts,
      ]
    );
    sse.emit("update", { kind: "sync", scope: "transfers", rexId: t.rex_id ?? null });
    return (await this.getTransferById(res.rows[0].id))!;
  },

  async updateTransfer(id: number, fields: Partial<TransferRow>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const push = (v: unknown) => {
      vals.push(v);
      return `$${vals.length}`;
    };
    const allowed = new Set(["status", "error_code", "message", "amount", "fee"]);
    for (const [k, v] of Object.entries(fields)) {
      if (!allowed.has(k) || v === undefined) continue;
      sets.push(`${k} = ${push(v)}`);
    }
    if (sets.length === 0) return;
    const pId = push(id);
    await query(`UPDATE transfers SET ${sets.join(", ")} WHERE id = ${pId}`, vals);

    const row = await this.getTransferById(id);
    if (fields.status === "success" || fields.status === "failed") {
      sse.emit("update", {
        kind: "transfer:result",
        scope: "transfers",
        rexId: row?.rex_id ?? null,
        id,
        status: fields.status,
        sender: row?.sender_phone ?? "",
        receiver: row?.receiver_phone ?? "",
        amount: row?.amount ?? 0,
        message: fields.message ?? row?.message ?? null,
      });
    } else {
      sse.emit("update", { kind: "sync", scope: "transfers", rexId: row?.rex_id ?? null });
    }
  },

  /**
   * Atomically enforce daily/monthly volume caps and SIM balance, then insert the
   * 'pending' transfer row — all in one transaction with the sender SIM row locked.
   * Throws TransferReservationError on cap/balance violations.
   */
  async reserveTransferSlot(t: {
    sender_phone: string;
    receiver_phone: string;
    rex_id?: number | null;
    created_by_user_id?: number | null;
    amount: number;
    fee: number;
  }): Promise<TransferRow> {
    const transferId = await withTransaction(async (client) => {
      const simRes = await client.query<{ id: number; balance: number | null }>(
        `SELECT id, balance, status FROM sims WHERE phone = $1 FOR UPDATE`,
        [t.sender_phone]
      );
      if (simRes.rows.length === 0) {
        throw new TransferReservationError("SIM not found", "sim_not_found", 404);
      }

      const todayStart = startOfToday();
      const monthStart = startOfThisMonth();
      // Only count pending rows from the last 5 minutes so stale crashed pending
      // rows do not permanently lock the SIM, while in-flight transfers still count.
      const recentPendingCutoff = now() - 300;

      const volRes = await client.query<{
        vol_today: number;
        vol_month: number;
        pending_cost: number;
      }>(
        `SELECT
           COALESCE(SUM(t.amount) FILTER (WHERE t.created_at >= $2), 0)::bigint AS vol_today,
           COALESCE(SUM(t.amount), 0)::bigint AS vol_month,
           COALESCE(SUM(t.amount + t.fee) FILTER (WHERE t.status = 'pending'), 0)::bigint AS pending_cost
         FROM transfers t
         WHERE t.sender_phone = $1
           AND t.created_at >= $3
           AND (t.status = 'success' OR (t.status = 'pending' AND t.created_at >= $4))`,
        [t.sender_phone, todayStart, monthStart, recentPendingCutoff]
      );
      const vols = volRes.rows[0];
      const volToday = Number(vols?.vol_today ?? 0);
      const volMonth = Number(vols?.vol_month ?? 0);
      const pendingCost = Number(vols?.pending_cost ?? 0);

      if (volToday + t.amount > DAILY_VOLUME_LIMIT) {
        throw new TransferReservationError(
          "Daily transfer volume limit reached",
          "daily_volume_limit",
          400
        );
      }
      if (volMonth + t.amount > MONTHLY_VOLUME_LIMIT) {
        throw new TransferReservationError(
          "Monthly transfer volume limit reached",
          "monthly_volume_limit",
          400
        );
      }

      const sim = simRes.rows[0];
      if (sim.balance !== null && sim.balance - pendingCost < t.amount + t.fee) {
        throw new TransferReservationError("Insufficient SIM balance", "insufficient_balance", 400);
      }

      const insRes = await client.query<{ id: number }>(
        `INSERT INTO transfers (sender_phone, receiver_phone, rex_id, created_by_user_id, amount, fee, status, error_code, message, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', NULL, NULL, $7)
         RETURNING id`,
        [
          t.sender_phone,
          t.receiver_phone,
          t.rex_id ?? null,
          t.created_by_user_id ?? null,
          t.amount,
          t.fee,
          now(),
        ]
      );
      return insRes.rows[0].id;
    });

    sse.emit("update", { kind: "sync", scope: "transfers", rexId: t.rex_id ?? null });
    return (await this.getTransferById(transferId))!;
  },

  /**
   * Finalize a pending transfer after the external call. Marks it success/failed and,
   * on success, debits the sender SIM balance in the SAME transaction (clamped at 0 so
   * a balance refresh race can never roll back the recorded successful transfer).
   * SSE events fire after commit.
   */
  async finalizeTransfer(
    id: number,
    result: { status: "success" | "failed"; error_code?: number | null; message?: string | null }
  ): Promise<TransferRow | undefined> {
    const info = await withTransaction(async (client) => {
      const updRes = await client.query<{
        sender_phone: string;
        receiver_phone: string;
        rex_id: number | null;
        amount: number;
        fee: number;
      }>(
        `UPDATE transfers
         SET status = $2, error_code = $3, message = $4
         WHERE id = $1 AND status = 'pending'
         RETURNING sender_phone, receiver_phone, rex_id, amount, fee`,
        [id, result.status, result.error_code ?? null, result.message ?? null]
      );
      if (updRes.rows.length === 0) return null;

      const row = updRes.rows[0];
      let debitedRexId: number | null | undefined;
      if (result.status === "success") {
        const debitRes = await client.query<{ rex_id: number | null }>(
          `UPDATE sims SET balance = GREATEST(0, balance - $2), updated_at = $3
           WHERE phone = $1 AND balance IS NOT NULL
           RETURNING rex_id`,
          [row.sender_phone, row.amount + row.fee, now()]
        );
        debitedRexId = debitRes.rows[0]?.rex_id ?? null;
      }
      return {
        sender_phone: row.sender_phone,
        receiver_phone: row.receiver_phone,
        rexId: row.rex_id,
        amount: row.amount,
        debitedRexId,
      };
    });

    if (!info) return this.getTransferById(id);

    sse.emit("update", {
      kind: "transfer:result",
      scope: "transfers",
      rexId: info.rexId ?? null,
      id,
      status: result.status,
      sender: info.sender_phone,
      receiver: info.receiver_phone,
      amount: info.amount,
      message: result.message ?? null,
    });
    if (info.debitedRexId !== undefined) {
      sse.emit("update", { kind: "sync", scope: "sim_balance", rexId: info.debitedRexId });
    }
    sse.emit("update", { kind: "sync", scope: "transfers", rexId: info.rexId ?? null });
    return this.getTransferById(id);
  },

  async listTransfers(limit = 1000, fromTs?: number, toTs?: number, rexId?: number | null): Promise<TransferRow[]> {
    const clauses: string[] = [];
    const args: unknown[] = [];
    const push = (v: unknown) => {
      args.push(v);
      return `$${args.length}`;
    };
    if (rexId !== undefined && rexId !== null) clauses.push(`t.rex_id = ${push(rexId)}`);
    if (fromTs !== undefined && toTs !== undefined) {
      clauses.push(`t.created_at >= ${push(fromTs)} AND t.created_at <= ${push(toTs)}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const pLimit = push(limit);
    const res = await query<TransferRow>(
      `SELECT ${TRANSFER_COLUMNS}
       FROM transfers t
       LEFT JOIN rex_groups rg ON rg.id = t.rex_id
       LEFT JOIN users u ON u.id = t.created_by_user_id
       ${where}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT ${pLimit}`,
      args
    );
    return res.rows;
  },

  async listTransfersFiltered(
    f: TransfersFilter,
    limit: number,
    offset: number
  ): Promise<{ rows: TransferRow[]; total: number }> {
    const { sql, args } = transfersWhereClause(f);
    const limitParam = `$${args.length + 1}`;
    const offsetParam = `$${args.length + 2}`;
    const res = await query<any>(
      `WITH total_cte AS (
         SELECT COUNT(*)::int AS _total FROM transfers t ${sql}
       ),
       rows_out AS (
         SELECT ${TRANSFER_COLUMNS},
                ROW_NUMBER() OVER (ORDER BY t.created_at DESC, t.id DESC) AS _ord
         FROM transfers t
         LEFT JOIN rex_groups rg ON rg.id = t.rex_id
         LEFT JOIN users u ON u.id = t.created_by_user_id
         ${sql}
         ORDER BY t.created_at DESC, t.id DESC
         LIMIT ${limitParam} OFFSET ${offsetParam}
       )
       SELECT tc._total, ${OUTER_TRANSFER_COLUMNS}
       FROM total_cte tc
       LEFT JOIN rows_out r ON TRUE
       ORDER BY r._ord ASC NULLS LAST`,
      [...args, limit, offset]
    );
    const total = Number(res.rows[0]?._total ?? 0);
    const rows = res.rows.filter((r) => r.id !== null).map(mapTransferRow);
    return { rows, total };
  },

  async listTransfersExportBatch(
    f: TransfersFilter,
    cursor: { createdAt: number; id: number } | null,
    limit: number
  ): Promise<TransferRow[]> {
    const { sql, args } = transfersWhereClause(f);
    const extraArgs = [...args];
    let whereSql = sql;
    if (cursor) {
      extraArgs.push(cursor.createdAt, cursor.id);
      const cursorClause = `(t.created_at, t.id) < ($${extraArgs.length - 1}, $${extraArgs.length})`;
      whereSql = whereSql ? `${whereSql} AND ${cursorClause}` : `WHERE ${cursorClause}`;
    }
    extraArgs.push(limit);
    const res = await query<TransferRow>(
      `SELECT ${TRANSFER_COLUMNS}
       FROM transfers t
       LEFT JOIN rex_groups rg ON rg.id = t.rex_id
       LEFT JOIN users u ON u.id = t.created_by_user_id
       ${whereSql}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT $${extraArgs.length}`,
      extraArgs
    );
    return res.rows;
  },

  async deleteTransfer(id: number): Promise<void> {
    const row = await this.getTransferById(id);
    await query(`DELETE FROM transfers WHERE id = $1`, [id]);
    sse.emit("update", { kind: "sync", scope: "transfers", rexId: row?.rex_id ?? null });
  },

  async todayVolumeBySender(phones?: string[], rexId?: number | null): Promise<Record<string, number>> {
    const clauses = [`created_at >= $1`, `status = 'success'`];
    const args: unknown[] = [startOfToday()];
    if (phones && phones.length > 0) {
      args.push(phones);
      clauses.push(`sender_phone = ANY($${args.length}::text[])`);
    }
    if (rexId !== undefined && rexId !== null) {
      args.push(rexId);
      clauses.push(`rex_id = $${args.length}`);
    }
    const res = await query<{ sender_phone: string; volume: number }>(
      `SELECT sender_phone, COALESCE(SUM(amount), 0)::bigint AS volume
       FROM transfers
       WHERE ${clauses.join(" AND ")}
       GROUP BY sender_phone`,
      args
    );
    return Object.fromEntries(res.rows.map((r) => [r.sender_phone, Number(r.volume)]));
  },

  async thisMonthVolumeBySender(phones?: string[], rexId?: number | null): Promise<Record<string, number>> {
    const clauses = [`created_at >= $1`, `status = 'success'`];
    const args: unknown[] = [startOfThisMonth()];
    if (phones && phones.length > 0) {
      args.push(phones);
      clauses.push(`sender_phone = ANY($${args.length}::text[])`);
    }
    if (rexId !== undefined && rexId !== null) {
      args.push(rexId);
      clauses.push(`rex_id = $${args.length}`);
    }
    const res = await query<{ sender_phone: string; volume: number }>(
      `SELECT sender_phone, COALESCE(SUM(amount), 0)::bigint AS volume
       FROM transfers
       WHERE ${clauses.join(" AND ")}
       GROUP BY sender_phone`,
      args
    );
    return Object.fromEntries(res.rows.map((r) => [r.sender_phone, Number(r.volume)]));
  },

  async rangeSeries(
    fromTs: number,
    toTs: number,
    granularity: Granularity,
    rexId?: number | null
  ): Promise<SeriesBucket[]> {
    const fmt = granularity === "hour" ? `YYYY-MM-DD"T"HH24` : `YYYY-MM-DD`;
    const args: unknown[] = [fromTs, toTs];
    const rexClause = rexId !== undefined && rexId !== null ? `AND rex_id = $3` : "";
    if (rexId !== undefined && rexId !== null) args.push(rexId);

    const res = await query<{ bucket: string; sent: number; failed: number; volume: number }>(
      `SELECT to_char(to_timestamp(created_at) AT TIME ZONE 'Asia/Yangon', '${fmt}') AS bucket,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END)::int AS sent,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int AS failed,
              COALESCE(SUM(CASE WHEN status = 'success' THEN amount ELSE 0 END), 0)::bigint AS volume
       FROM transfers
       WHERE created_at >= $1 AND created_at < $2 ${rexClause}
       GROUP BY bucket`,
      args
    );

    const byKey = new Map(res.rows.map((r) => [r.bucket, r]));
    const nowSec = now();
    const out: SeriesBucket[] = [];
    const stepSec = granularity === "hour" ? 3600 : 86400;

    let ts = alignBucketStart(fromTs, granularity);
    for (let i = 0; i < 2000; i++) {
      if (ts >= toTs || ts > nowSec) break;
      const hit = byKey.get(bucketKey(ts, granularity));
      out.push({
        ts,
        sent: Number(hit?.sent ?? 0),
        failed: Number(hit?.failed ?? 0),
        volume: Number(hit?.volume ?? 0),
      });
      ts += stepSec;
    }
    return out;
  },

  async topErrors(fromTs: number, toTs: number, rexId?: number | null): Promise<{ reason: string; count: number }[]> {
    const args: unknown[] = [fromTs, toTs];
    const rexClause = rexId !== undefined && rexId !== null ? `AND rex_id = $3` : "";
    if (rexId !== undefined && rexId !== null) args.push(rexId);

    const res = await query<{ reason: string; count: number }>(
      `SELECT COALESCE(message, 'Error ' || error_code::text, 'Unknown Error') AS reason,
              COUNT(*)::int AS count
       FROM transfers
       WHERE status = 'failed' AND created_at >= $1 AND created_at < $2 ${rexClause}
       GROUP BY reason
       ORDER BY count DESC
       LIMIT 5`,
      args
    );
    return res.rows;
  },

  async receiversInRange(
    fromTs?: number,
    toTs?: number,
    sender?: string,
    rexId?: number | null
  ): Promise<{ groups: ReceiverGroup[]; senders: string[]; transferCount: number }> {
    const from = fromTs ?? 0;
    const to = toTs ?? 9_999_999_999;

    const baseArgs: unknown[] = [from, to];
    const baseClauses = [`t.status = 'success'`, `t.created_at >= $1`, `t.created_at <= $2`];
    if (rexId !== undefined && rexId !== null) {
      baseArgs.push(rexId);
      baseClauses.push(`t.rex_id = $${baseArgs.length}`);
    }

    const groupArgs = [...baseArgs];
    const groupClauses = [...baseClauses];
    if (sender) {
      groupArgs.push(sender);
      groupClauses.push(`t.sender_phone = $${groupArgs.length}`);
    }
    groupArgs.push(RECEIVER_GROUP_CAP);

    const [groupsRes, sendersRes] = await Promise.all([
      query<{
        phone: string;
        total_amount: number;
        total_fee: number;
        success_count: number;
        last_at: number;
      }>(
        `SELECT t.receiver_phone AS phone,
                COALESCE(SUM(t.amount), 0)::bigint AS total_amount,
                COALESCE(SUM(t.fee), 0)::bigint AS total_fee,
                COUNT(*)::int AS success_count,
                MAX(t.created_at)::bigint AS last_at
         FROM transfers t
         WHERE ${groupClauses.join(" AND ")}
         GROUP BY t.receiver_phone
         ORDER BY total_amount DESC, last_at DESC
         LIMIT $${groupArgs.length}`,
        groupArgs
      ),
      query<{ sender_phone: string }>(
        `SELECT DISTINCT t.sender_phone
         FROM transfers t
         WHERE ${baseClauses.join(" AND ")}
         ORDER BY t.sender_phone`,
        baseArgs
      ),
    ]);

    let transferCount = 0;
    const groups: ReceiverGroup[] = groupsRes.rows.map((r) => {
      const successCount = Number(r.success_count ?? 0);
      transferCount += successCount;
      return {
        phone: String(r.phone),
        totalAmount: Number(r.total_amount ?? 0),
        totalFee: Number(r.total_fee ?? 0),
        successCount,
        lastAt: Number(r.last_at ?? 0),
      };
    });

    return {
      groups,
      senders: sendersRes.rows.map((r) => r.sender_phone),
      transferCount,
    };
  },

  async receiverTransfers(
    receiverPhone: string,
    fromTs?: number,
    toTs?: number,
    sender?: string,
    rexId?: number | null
  ): Promise<TransferRow[]> {
    const from = fromTs ?? 0;
    const to = toTs ?? 9_999_999_999;

    const args: unknown[] = [from, to, receiverPhone];
    const clauses = [
      `t.status = 'success'`,
      `t.created_at >= $1`,
      `t.created_at <= $2`,
      `t.receiver_phone = $3`,
    ];
    if (rexId !== undefined && rexId !== null) {
      args.push(rexId);
      clauses.push(`t.rex_id = $${args.length}`);
    }
    if (sender) {
      args.push(sender);
      clauses.push(`t.sender_phone = $${args.length}`);
    }
    args.push(RECEIVER_DETAIL_CAP);

    const res = await query<TransferRow>(
      `SELECT ${TRANSFER_COLUMNS}
       FROM transfers t
       LEFT JOIN rex_groups rg ON rg.id = t.rex_id
       LEFT JOIN users u ON u.id = t.created_by_user_id
       WHERE ${clauses.join(" AND ")}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT $${args.length}`,
      args
    );
    return res.rows;
  },

  async trayStats(rexId?: number | null, opts?: { includeRecent?: boolean }) {
    const args: unknown[] = [];
    const hasRex = rexId !== undefined && rexId !== null;
    if (hasRex) args.push(rexId);
    const simWhere = hasRex ? `WHERE rex_id = $1` : "";
    const transferWhere = hasRex ? `WHERE t.rex_id = $1` : "";
    const includeRecent = opts?.includeRecent ?? true;

    if (!includeRecent) {
      const simStatsRes = await query<{ sim_count: number; logged_in: number; total_balance: number }>(
        `SELECT
           COUNT(*)::int AS sim_count,
           COUNT(*) FILTER (WHERE status = 'active')::int AS logged_in,
           COALESCE(SUM(balance) FILTER (WHERE status = 'active'), 0)::bigint AS total_balance
         FROM sims
         ${simWhere}`,
        args
      );
      const s = simStatsRes.rows[0] ?? { sim_count: 0, logged_in: 0, total_balance: 0 };
      return {
        simCount: Number(s.sim_count),
        loggedIn: Number(s.logged_in),
        totalBalance: Number(s.total_balance),
        recent: [] as TransferRow[],
      };
    }

    const res = await query<any>(
      `WITH sim_stats AS (
         SELECT
           COUNT(*)::int AS _sim_count,
           COUNT(*) FILTER (WHERE status = 'active')::int AS _logged_in,
           COALESCE(SUM(balance) FILTER (WHERE status = 'active'), 0)::bigint AS _total_balance
         FROM sims
         ${simWhere}
       ),
       recent_rows AS (
         SELECT ${TRANSFER_COLUMNS},
                ROW_NUMBER() OVER (ORDER BY t.created_at DESC, t.id DESC) AS _ord
         FROM transfers t
         LEFT JOIN rex_groups rg ON rg.id = t.rex_id
         LEFT JOIN users u ON u.id = t.created_by_user_id
         ${transferWhere}
         ORDER BY t.created_at DESC, t.id DESC
         LIMIT 5
       )
       SELECT ss._sim_count, ss._logged_in, ss._total_balance, ${OUTER_TRANSFER_COLUMNS}
       FROM sim_stats ss
       LEFT JOIN recent_rows r ON TRUE
       ORDER BY r._ord ASC NULLS LAST`,
      args
    );

    const first = res.rows[0];
    return {
      simCount: Number(first?._sim_count ?? 0),
      loggedIn: Number(first?._logged_in ?? 0),
      totalBalance: Number(first?._total_balance ?? 0),
      recent: res.rows.filter((r) => r.id !== null).map(mapTransferRow),
    };
  },
};
