import { query, withTransaction } from "./pg";
import { sse } from "./events";
import { phoneSearchKeys } from "./format";
import { decryptSecret, encryptSecret } from "./crypto";
import { LOW_BALANCE_THRESHOLD } from "./constants";
import { normalizePermissions, type RolePermissions } from "./permissions";

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
  transfers: TransferRow[];
}

const TRANSFER_COLUMNS =
  "t.id, t.sender_phone, t.receiver_phone, t.rex_id, rg.name AS rex_name, " +
  "t.created_by_user_id, u.username AS created_by_username, " +
  "t.amount, t.fee, t.status, t.error_code, t.message, t.created_at";

const PUBLIC_SIM_COLUMNS =
  "s.id, s.phone, s.rex_id, rg.name AS rex_name, s.added_by_user_id, " +
  "s.token_expires_at, s.refresh_expires_at, s.subscription_id, s.balance, " +
  "s.balance_checked_at, s.bill_expire_at, s.block_one_way, s.block_two_way, s.sim_status_text, " +
  "s.status, s.note, s.created_at, s.updated_at";

const PARSED_EXPIRY_DATE_SQL = `
  CASE
    WHEN NULLIF(BTRIM(s.bill_expire_at), '') IS NULL THEN NULL
    WHEN BTRIM(s.bill_expire_at) ~ '^(0[1-9]|[12][0-9]|3[01])/(0[1-9]|1[0-2])/[0-9]{4}' THEN
      TO_DATE(SUBSTRING(BTRIM(s.bill_expire_at) FROM 1 FOR 10), 'DD/MM/YYYY')
    WHEN BTRIM(s.bill_expire_at) ~ '^(0[1-9]|[12][0-9]|3[01])-(0[1-9]|1[0-2])-[0-9]{4}' THEN
      TO_DATE(SUBSTRING(BTRIM(s.bill_expire_at) FROM 1 FOR 10), 'DD-MM-YYYY')
    WHEN BTRIM(s.bill_expire_at) ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])' THEN
      TO_DATE(SUBSTRING(BTRIM(s.bill_expire_at) FROM 1 FOR 10), 'YYYY-MM-DD')
    WHEN BTRIM(s.bill_expire_at) ~ '^[0-9]{13}$' THEN
      (TO_TIMESTAMP(BTRIM(s.bill_expire_at)::bigint / 1000.0) AT TIME ZONE 'Asia/Yangon')::date
    WHEN BTRIM(s.bill_expire_at) ~ '^[0-9]{10}$' THEN
      (TO_TIMESTAMP(BTRIM(s.bill_expire_at)::bigint) AT TIME ZONE 'Asia/Yangon')::date
    ELSE NULL
  END
`;

const TODAY_MM_SQL = `(NOW() AT TIME ZONE 'Asia/Yangon')::date`;
const EXPIRING_SOON_DAYS = 10;

const ENCRYPTED_SIM_COLUMNS = ["access_token", "refresh_token"] as const;
const RECEIVER_ROW_CAP = 200_000;
const MM_OFFSET_SEC = 6 * 3600 + 30 * 60; // Asia/Yangon UTC+06:30 (no DST)

const now = () => Math.floor(Date.now() / 1000);

function decodeSim<T extends SimRow | undefined>(row: T): T {
  if (!row) return row;
  row.access_token = decryptSecret(row.access_token);
  row.refresh_token = decryptSecret(row.refresh_token);
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
    const res = await query(
      `SELECT u.*, r.name AS role_name, r.permissions, rg.name AS rex_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN rex_groups rg ON rg.id = u.rex_id
       WHERE u.id = $1
       LIMIT 1`,
      [userId]
    );
    if (!res.rows[0]) return undefined;
    return mapUserRow(res.rows[0]);
  },

  async listUsers(): Promise<UserRow[]> {
    const res = await query(
      `SELECT u.id, u.username, u.role_id, r.name AS role_name, u.rex_id, rg.name AS rex_name,
              u.is_active, u.token_version, u.is_env_admin, u.created_at, u.updated_at
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN rex_groups rg ON rg.id = u.rex_id
       ORDER BY u.is_env_admin DESC, u.created_at DESC, u.id DESC`
    );
    return res.rows.map((r) => ({
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
    return this.getUserSessionById(id);
  },

  async deleteUser(id: number): Promise<boolean> {
    const res = await query(`DELETE FROM users WHERE id = $1 AND is_env_admin = FALSE`, [id]);
    return (res.rowCount ?? 0) > 0;
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
    return { deleted: true };
  },

  async listRexGroups(): Promise<RexGroupRow[]> {
    const res = await query(
      `SELECT rg.id, rg.name, rg.created_at,
              COUNT(DISTINCT s.id)::int AS sim_count,
              COUNT(DISTINCT CASE WHEN s.status = 'active' THEN s.id END)::int AS active_sim_count,
              COUNT(DISTINCT u.id)::int AS user_count
       FROM rex_groups rg
       LEFT JOIN sims s ON s.rex_id = rg.id
       LEFT JOIN users u ON u.rex_id = rg.id
       GROUP BY rg.id
       ORDER BY rg.name_lower ASC`
    );
    return res.rows.map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      created_at: Number(r.created_at),
      sim_count: Number(r.sim_count ?? 0),
      active_sim_count: Number(r.active_sim_count ?? 0),
      user_count: Number(r.user_count ?? 0),
    }));
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
    return res.rows[0];
  },

  async renameRexGroup(id: number, name: string): Promise<RexGroupRow | undefined> {
    const clean = name.trim();
    const res = await query<RexGroupRow>(
      `UPDATE rex_groups SET name = $1, name_lower = $2 WHERE id = $3 RETURNING id, name, created_at`,
      [clean, clean.toLowerCase(), id]
    );
    return res.rows[0];
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

  async listSimsPublic(opts?: { rexId?: number | null; status?: string; limit?: number }): Promise<PublicSimRow[]> {
    const clauses: string[] = [];
    const args: unknown[] = [];
    if (opts?.rexId !== undefined && opts.rexId !== null) {
      args.push(opts.rexId);
      clauses.push(`s.rex_id = $${args.length}`);
    }
    if (opts?.status) {
      args.push(opts.status);
      clauses.push(`s.status = $${args.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitSql = opts?.limit ? `LIMIT ${Math.max(1, Math.min(5000, opts.limit))}` : "";
    const res = await query<PublicSimRow>(
      `SELECT ${PUBLIC_SIM_COLUMNS}
       FROM sims s
       LEFT JOIN rex_groups rg ON rg.id = s.rex_id
       ${where}
       ORDER BY s.updated_at DESC
       ${limitSql}`,
      args
    );
    return res.rows;
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
    const scopeClauses: string[] = [];
    const scopeArgs: unknown[] = [];
    if (q.rexId !== undefined && q.rexId !== null) {
      scopeArgs.push(q.rexId);
      scopeClauses.push(`s.rex_id = $${scopeArgs.length}`);
    }
    const scopeWhere = scopeClauses.length ? `WHERE ${scopeClauses.join(" AND ")}` : "";

    const lowParamIdx = scopeArgs.length + 1;
    const daysParamIdx = scopeArgs.length + 2;
    const countsRes = await query<{
      all: number;
      active: number;
      inactive: number;
      drained: number;
      expiring: number;
      expired: number;
    }>(
      `WITH scoped AS (
         SELECT s.status, s.balance, (${PARSED_EXPIRY_DATE_SQL}) AS exp_date
         FROM sims s
         ${scopeWhere}
       )
       SELECT
         COUNT(*)::int AS all,
         COUNT(*) FILTER (WHERE status = 'active')::int AS active,
         COUNT(*) FILTER (WHERE status <> 'active')::int AS inactive,
         COUNT(*) FILTER (WHERE status = 'active' AND balance IS NOT NULL AND balance < $${lowParamIdx})::int AS drained,
         COUNT(*) FILTER (WHERE exp_date IS NOT NULL AND exp_date > ${TODAY_MM_SQL} AND (exp_date - ${TODAY_MM_SQL}) <= $${daysParamIdx})::int AS expiring,
         COUNT(*) FILTER (WHERE exp_date IS NOT NULL AND exp_date <= ${TODAY_MM_SQL})::int AS expired
       FROM scoped`,
      [...scopeArgs, LOW_BALANCE_THRESHOLD, EXPIRING_SOON_DAYS]
    );
    const counts = countsRes.rows[0] ?? {
      all: 0,
      active: 0,
      inactive: 0,
      drained: 0,
      expiring: 0,
      expired: 0,
    };

    const clauses: string[] = [];
    const args = [...scopeArgs];
    const push = (v: unknown) => {
      args.push(v);
      return `$${args.length}`;
    };

    if (q.view === "active") {
      clauses.push(`s.status = 'active'`);
    } else if (q.view === "inactive") {
      clauses.push(`s.status <> 'active'`);
    } else if (q.view === "drained") {
      clauses.push(`s.status = 'active' AND s.balance IS NOT NULL AND s.balance < ${push(LOW_BALANCE_THRESHOLD)}`);
    } else if (q.view === "expiring") {
      clauses.push(`s.exp_date IS NOT NULL AND s.exp_date > ${TODAY_MM_SQL} AND (s.exp_date - ${TODAY_MM_SQL}) <= ${push(EXPIRING_SOON_DAYS)}`);
    } else if (q.view === "expired") {
      clauses.push(`s.exp_date IS NOT NULL AND s.exp_date <= ${TODAY_MM_SQL}`);
    }

    const searchRaw = q.q?.trim();
    if (searchRaw) {
      const cleanPhone = searchRaw.toLowerCase().replace(/[\s-+]/g, "");
      const ors: string[] = [
        `LOWER(COALESCE(s.note, '')) LIKE ${push(likePattern(searchRaw.toLowerCase()))} ESCAPE '\\'`,
        `LOWER(COALESCE(s.rex_name, '')) LIKE ${push(likePattern(searchRaw.toLowerCase()))} ESCAPE '\\'`,
      ];
      if (cleanPhone) {
        ors.push(`REPLACE(REPLACE(LOWER(s.phone), ' ', ''), '+', '') LIKE ${push(likePattern(cleanPhone))} ESCAPE '\\'`);
      }
      clauses.push(`(${ors.join(" OR ")})`);
    }

    const whereSql = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

    const baseCte = `
      WITH scoped AS (
        SELECT ${PUBLIC_SIM_COLUMNS}, (${PARSED_EXPIRY_DATE_SQL}) AS exp_date
        FROM sims s
        LEFT JOIN rex_groups rg ON rg.id = s.rex_id
        ${scopeWhere}
      )
    `;

    const totalRes = await query<{ c: number }>(
      `${baseCte}
       SELECT COUNT(*)::int AS c
       FROM scoped s
       ${whereSql}`,
      args
    );
    const total = totalRes.rows[0]?.c ?? 0;

    let orderSql = "s.updated_at DESC, s.id DESC";
    if (q.sort === "balance-asc") {
      orderSql = "CASE WHEN s.balance IS NULL THEN 1 ELSE 0 END ASC, s.balance ASC, s.updated_at DESC";
    } else if (q.sort === "balance-desc") {
      orderSql = "CASE WHEN s.balance IS NULL THEN 1 ELSE 0 END ASC, s.balance DESC, s.updated_at DESC";
    } else if (q.sort === "expiry-asc") {
      orderSql = "CASE WHEN s.exp_date IS NULL THEN 1 ELSE 0 END ASC, s.exp_date ASC, s.updated_at DESC";
    }

    const limitParam = push(q.pageSize);
    const offsetParam = push((Math.max(1, q.page) - 1) * q.pageSize);

    const rowsRes = await query<PublicSimRow>(
      `${baseCte}
       SELECT s.id, s.phone, s.rex_id, s.rex_name, s.added_by_user_id,
              s.token_expires_at, s.refresh_expires_at, s.subscription_id, s.balance,
              s.balance_checked_at, s.bill_expire_at, s.block_one_way, s.block_two_way, s.sim_status_text,
              s.status, s.note, s.created_at, s.updated_at
       FROM scoped s
       ${whereSql}
       ORDER BY ${orderSql}
       LIMIT ${limitParam} OFFSET ${offsetParam}`,
      args
    );

    const simsPage = rowsRes.rows;
    if (simsPage.length === 0) {
      return { sims: [], total, counts };
    }

    const phones = simsPage.map((s) => s.phone);
    const [todayVol, monthVol] = await Promise.all([
      this.todayVolumeBySender(phones),
      this.thisMonthVolumeBySender(phones),
    ]);

    return {
      sims: simsPage.map((s) => ({
        ...s,
        volume_today: todayVol[s.phone] ?? 0,
        volume_this_month: monthVol[s.phone] ?? 0,
      })),
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

      const skipKeys = new Set(["phone", "id", "rex_name", "created_at"]);
      for (const [k, v] of Object.entries(fields)) {
        if (skipKeys.has(k) || v === undefined) continue;
        const val = ENCRYPTED_SIM_COLUMNS.includes(k as (typeof ENCRYPTED_SIM_COLUMNS)[number])
          ? encryptSecret(v as string | null)
          : v;
        sets.push(`${k} = ${push(val)}`);
      }
      if (sets.length > 0) {
        sets.push(`updated_at = ${push(ts)}`);
        const pPhone = push(phone);
        await client.query(`UPDATE sims SET ${sets.join(", ")} WHERE phone = ${pPhone}`, vals);
      }
    });

    const updated = (await this.getSim(phone))!;
    sse.emit("update", { kind: "sync", rexId: updated.rex_id });
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
      const notified = new Set<number | null>();
      for (const r of prevRexRes.rows) notified.add(r.rex_id);
      notified.add(targetRexId);
      for (const rexId of notified) {
        sse.emit("update", { kind: "sync", rexId });
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
      for (const r of rexRes.rows) {
        sse.emit("update", { kind: "sync", rexId: r.rex_id });
      }
    }
    return removed;
  },

  async debitSimBalance(phone: string, amount: number): Promise<void> {
    const res = await query<{ rex_id: number | null }>(
      `UPDATE sims SET balance = balance - $1, updated_at = $2
       WHERE phone = $3 AND balance IS NOT NULL
       RETURNING rex_id`,
      [amount, now(), phone]
    );
    if ((res.rowCount ?? 0) > 0) {
      sse.emit("update", { kind: "sync", rexId: res.rows[0].rex_id });
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
    sse.emit("update", { kind: "sync", rexId: t.rex_id ?? null });
    return (await this.getTransferById(res.rows[0].id))!;
  },

  async updateTransfer(id: number, fields: Partial<TransferRow>): Promise<void> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const push = (v: unknown) => {
      vals.push(v);
      return `$${vals.length}`;
    };
    const skip = new Set(["id", "rex_name", "created_by_username"]);
    for (const [k, v] of Object.entries(fields)) {
      if (skip.has(k) || v === undefined) continue;
      sets.push(`${k} = ${push(v)}`);
    }
    if (sets.length === 0) return;
    const pId = push(id);
    await query(`UPDATE transfers SET ${sets.join(", ")} WHERE id = ${pId}`, vals);

    const row = await this.getTransferById(id);
    if (fields.status === "success" || fields.status === "failed") {
      sse.emit("update", {
        kind: "transfer:result",
        rexId: row?.rex_id ?? null,
        id,
        status: fields.status,
        sender: row?.sender_phone ?? "",
        receiver: row?.receiver_phone ?? "",
        amount: row?.amount ?? 0,
        message: fields.message ?? row?.message ?? null,
      });
    } else {
      sse.emit("update", { kind: "sync", rexId: row?.rex_id ?? null });
    }
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
    const rowsRes = await query<TransferRow>(
      `SELECT ${TRANSFER_COLUMNS}
       FROM transfers t
       LEFT JOIN rex_groups rg ON rg.id = t.rex_id
       LEFT JOIN users u ON u.id = t.created_by_user_id
       ${sql}
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT $${args.length + 1} OFFSET $${args.length + 2}`,
      [...args, limit, offset]
    );
    const countRes = await query<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM transfers t ${sql}`,
      args
    );
    return { rows: rowsRes.rows, total: countRes.rows[0]?.c ?? 0 };
  },

  async deleteTransfer(id: number): Promise<void> {
    const row = await this.getTransferById(id);
    await query(`DELETE FROM transfers WHERE id = $1`, [id]);
    sse.emit("update", { kind: "sync", rexId: row?.rex_id ?? null });
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

    const senderArgs = [...baseArgs];
    const rowClauses = [...baseClauses];
    if (sender) {
      senderArgs.push(sender);
      rowClauses.push(`t.sender_phone = $${senderArgs.length}`);
    }
    senderArgs.push(RECEIVER_ROW_CAP);

    const [rowsRes, sendersRes] = await Promise.all([
      query<TransferRow>(
        `SELECT ${TRANSFER_COLUMNS}
         FROM transfers t
         LEFT JOIN rex_groups rg ON rg.id = t.rex_id
         LEFT JOIN users u ON u.id = t.created_by_user_id
         WHERE ${rowClauses.join(" AND ")}
         ORDER BY t.created_at DESC, t.id DESC
         LIMIT $${senderArgs.length}`,
        senderArgs
      ),
      query<{ sender_phone: string }>(
        `SELECT DISTINCT t.sender_phone
         FROM transfers t
         WHERE ${baseClauses.join(" AND ")}
         ORDER BY t.sender_phone`,
        baseArgs
      ),
    ]);

    const byReceiver = new Map<string, ReceiverGroup>();
    for (const row of rowsRes.rows) {
      let group = byReceiver.get(row.receiver_phone);
      if (!group) {
        group = {
          phone: row.receiver_phone,
          totalAmount: 0,
          totalFee: 0,
          successCount: 0,
          lastAt: 0,
          transfers: [],
        };
        byReceiver.set(row.receiver_phone, group);
      }
      group.transfers.push(row);
      group.totalAmount += row.amount;
      group.totalFee += row.fee || 0;
      group.successCount += 1;
      if (row.created_at > group.lastAt) group.lastAt = row.created_at;
    }

    return {
      groups: [...byReceiver.values()],
      senders: sendersRes.rows.map((r) => r.sender_phone),
      transferCount: rowsRes.rows.length,
    };
  },

  async trayStats(rexId?: number | null) {
    const args: unknown[] = [];
    const simWhere = rexId !== undefined && rexId !== null ? `WHERE rex_id = $1` : "";
    const activeWhere =
      rexId !== undefined && rexId !== null
        ? `WHERE status = 'active' AND rex_id = $1`
        : `WHERE status = 'active'`;
    if (rexId !== undefined && rexId !== null) args.push(rexId);

    const [simStatsRes, recent] = await Promise.all([
      query<{ sim_count: number; logged_in: number; total_balance: number }>(
        `SELECT
           (SELECT COUNT(*)::int FROM sims ${simWhere}) AS sim_count,
           (SELECT COUNT(*)::int FROM sims ${activeWhere}) AS logged_in,
           (SELECT COALESCE(SUM(balance), 0)::bigint FROM sims ${activeWhere}) AS total_balance`,
        args
      ),
      this.listTransfers(5, undefined, undefined, rexId),
    ]);

    const s = simStatsRes.rows[0] ?? { sim_count: 0, logged_in: 0, total_balance: 0 };
    return {
      simCount: Number(s.sim_count),
      loggedIn: Number(s.logged_in),
      totalBalance: Number(s.total_balance),
      recent,
    };
  },
};
