/**
 * PostgreSQL connection pool and idempotent schema/seed initializer (Aiven-ready).
 * Node-only — never import in client components or Edge middleware.
 */
import { Pool, types, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { hashPassword, verifyPasswordHash } from "./password";
import { parseBillExpireDate } from "./format";
import { DEFAULT_ADMIN_PERMISSIONS, DEFAULT_STAFF_PERMISSIONS } from "./permissions";

// Parse PostgreSQL INT8 / BIGINT (OID 20) into JS numbers (safe for unix ts & MMK amounts).
types.setTypeParser(20, (val: string) => (val === null ? 0 : Number(val)));

const globalForPg = globalThis as unknown as {
  __mysharePgPool?: Pool;
  __myshareDbInit?: Promise<void>;
};

function createPool(): Pool {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) {
    throw new Error("DATABASE_URL is not configured in the environment.");
  }

  const parsed = new URL(rawUrl);
  const sslMode = parsed.searchParams.get("sslmode");
  // Remove sslmode from URL so pg-connection-string does not override explicit `ssl` object below.
  parsed.searchParams.delete("sslmode");

  const ca = process.env.PG_SSL_CA?.replace(/\\n/g, "\n");
  const useSsl = sslMode !== "disable";

  return new Pool({
    connectionString: parsed.toString(),
    ssl: useSsl
      ? ca
        ? { ca, rejectUnauthorized: true }
        : { rejectUnauthorized: false }
      : false,
    max: Number(process.env.PG_POOL_MAX) || 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
  });
}

export function getPool(): Pool {
  if (!globalForPg.__mysharePgPool) {
    globalForPg.__mysharePgPool = createPool();
  }
  return globalForPg.__mysharePgPool;
}

const nowSec = () => Math.floor(Date.now() / 1000);

async function initSchemaAndSeed(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS rex_groups (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        name_lower TEXT UNIQUE NOT NULL,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS roles (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        name_lower TEXT UNIQUE NOT NULL,
        is_system BOOLEAN NOT NULL DEFAULT FALSE,
        permissions JSONB NOT NULL,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        username_lower TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role_id INTEGER NOT NULL REFERENCES roles(id),
        rex_id INTEGER REFERENCES rex_groups(id) ON DELETE RESTRICT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        token_version INTEGER NOT NULL DEFAULT 1,
        is_env_admin BOOLEAN NOT NULL DEFAULT FALSE,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sims (
        id SERIAL PRIMARY KEY,
        phone TEXT UNIQUE NOT NULL,
        rex_id INTEGER REFERENCES rex_groups(id) ON DELETE SET NULL,
        added_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        access_token TEXT,
        refresh_token TEXT,
        token_expires_at BIGINT,
        refresh_expires_at BIGINT,
        subscription_id TEXT,
        balance BIGINT,
        balance_checked_at BIGINT,
        bill_expire_at TEXT,
        bill_expire_date DATE,
        block_one_way TEXT,
        block_two_way TEXT,
        sim_status_text TEXT,
        status TEXT NOT NULL DEFAULT 'logged_out',
        note TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transfers (
        id SERIAL PRIMARY KEY,
        sender_phone TEXT NOT NULL,
        receiver_phone TEXT NOT NULL,
        rex_id INTEGER REFERENCES rex_groups(id) ON DELETE SET NULL,
        created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        amount INTEGER NOT NULL,
        fee INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_code INTEGER,
        message TEXT,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        actor_username TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        detail JSONB,
        created_at BIGINT NOT NULL
      );

      ALTER TABLE sims ADD COLUMN IF NOT EXISTS bill_expire_date DATE;

      CREATE INDEX IF NOT EXISTS idx_transfers_created_status ON transfers(created_at, status);
      CREATE INDEX IF NOT EXISTS idx_transfers_created_id ON transfers(created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_transfers_sender ON transfers(sender_phone);
      CREATE INDEX IF NOT EXISTS idx_transfers_rex_created ON transfers(rex_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_transfers_status_created_sender ON transfers(status, created_at, sender_phone);
      CREATE INDEX IF NOT EXISTS idx_transfers_rex_status_created ON transfers(rex_id, status, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_transfers_receiver_created ON transfers(receiver_phone, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sims_status ON sims(status);
      CREATE INDEX IF NOT EXISTS idx_sims_updated ON sims(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sims_rex_status ON sims(rex_id, status);
      CREATE INDEX IF NOT EXISTS idx_sims_rex_exp_date ON sims(rex_id, bill_expire_date);
      CREATE INDEX IF NOT EXISTS idx_users_role ON users(role_id);
      CREATE INDEX IF NOT EXISTS idx_users_rex ON users(rex_id);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

      DO $$
      BEGIN
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        CREATE INDEX IF NOT EXISTS idx_sims_phone_trgm ON sims USING GIN (phone gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS idx_sims_note_trgm ON sims USING GIN (LOWER(COALESCE(note, '')) gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS idx_transfers_sender_trgm ON transfers USING GIN (sender_phone gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS idx_transfers_receiver_trgm ON transfers USING GIN (receiver_phone gin_trgm_ops);
        CREATE INDEX IF NOT EXISTS idx_transfers_msg_trgm ON transfers USING GIN (LOWER(COALESCE(message, '')) gin_trgm_ops);
      EXCEPTION WHEN OTHERS THEN
        NULL;
      END
      $$;
    `);

    // Backfill pre-parsed bill_expire_date once for existing SIM rows.
    const unparsedSims = await client.query<{ id: number; bill_expire_at: string }>(
      `SELECT id, bill_expire_at FROM sims WHERE bill_expire_at IS NOT NULL AND bill_expire_date IS NULL`
    );
    if (unparsedSims.rows.length > 0) {
      const ids: number[] = [];
      const dates: string[] = [];
      for (const row of unparsedSims.rows) {
        const iso = parseBillExpireDate(row.bill_expire_at);
        if (iso) {
          ids.push(row.id);
          dates.push(iso);
        }
      }
      if (ids.length > 0) {
        await client.query(
          `UPDATE sims AS s
           SET bill_expire_date = v.d
           FROM (SELECT UNNEST($1::int[]) AS id, UNNEST($2::date[]) AS d) AS v
           WHERE s.id = v.id`,
          [ids, dates]
        );
      }
    }

    const ts = nowSec();

    // Seed system roles idempotently
    await client.query(
      `INSERT INTO roles (name, name_lower, is_system, permissions, created_at, updated_at)
       VALUES ($1, $2, TRUE, $3::jsonb, $4, $4)
       ON CONFLICT (name_lower) DO UPDATE
       SET is_system = TRUE, permissions = EXCLUDED.permissions, updated_at = EXCLUDED.updated_at`,
      ["Admin", "admin", JSON.stringify(DEFAULT_ADMIN_PERMISSIONS), ts]
    );

    await client.query(
      `INSERT INTO roles (name, name_lower, is_system, permissions, created_at, updated_at)
       VALUES ($1, $2, TRUE, $3::jsonb, $4, $4)
       ON CONFLICT (name_lower) DO NOTHING`,
      ["Staff", "staff", JSON.stringify(DEFAULT_STAFF_PERMISSIONS), ts]
    );

    const adminRoleRes = await client.query<{ id: number }>(
      `SELECT id FROM roles WHERE name_lower = 'admin' LIMIT 1`
    );
    const adminRoleId = adminRoleRes.rows[0].id;

    // Sync configurable .env Root Admin (ADMIN_USERNAME + AUTH_PASSWORD)
    const adminUsername = (process.env.ADMIN_USERNAME || "MyShareAdmin").trim() || "MyShareAdmin";
    const adminUsernameLower = adminUsername.toLowerCase();
    const adminPassword = process.env.AUTH_PASSWORD;

    if (adminPassword) {
      const existingEnvAdmin = await client.query<{
        id: number;
        username: string;
        password_hash: string;
        role_id: number;
        rex_id: number | null;
        is_active: boolean;
      }>(
        `SELECT id, username, password_hash, role_id, rex_id, is_active
         FROM users WHERE is_env_admin = TRUE LIMIT 1`
      );

      if (existingEnvAdmin.rows.length > 0) {
        const row = existingEnvAdmin.rows[0];
        const usernameChanged = row.username !== adminUsername;
        const passwordChanged = !verifyPasswordHash(adminPassword, row.password_hash);
        if (
          usernameChanged ||
          passwordChanged ||
          row.role_id !== adminRoleId ||
          row.rex_id !== null ||
          !row.is_active
        ) {
          const nextHash = passwordChanged ? hashPassword(adminPassword) : row.password_hash;
          const bumpVersion = usernameChanged || passwordChanged ? 1 : 0;
          await client.query(
            `UPDATE users
             SET username = $1,
                 username_lower = $2,
                 password_hash = $3,
                 role_id = $4,
                 rex_id = NULL,
                 is_active = TRUE,
                 token_version = token_version + $5,
                 updated_at = $6
             WHERE id = $7`,
            [adminUsername, adminUsernameLower, nextHash, adminRoleId, bumpVersion, ts, row.id]
          );
        }
      } else {
        const existingByName = await client.query<{ id: number }>(
          `SELECT id FROM users WHERE username_lower = $1 LIMIT 1`,
          [adminUsernameLower]
        );
        const pwHash = hashPassword(adminPassword);
        if (existingByName.rows.length > 0) {
          await client.query(
            `UPDATE users
             SET username = $1,
                 password_hash = $2,
                 role_id = $3,
                 rex_id = NULL,
                 is_active = TRUE,
                 is_env_admin = TRUE,
                 token_version = token_version + 1,
                 updated_at = $4
             WHERE id = $5`,
            [adminUsername, pwHash, adminRoleId, ts, existingByName.rows[0].id]
          );
        } else {
          await client.query(
            `INSERT INTO users (username, username_lower, password_hash, role_id, rex_id, is_active, is_env_admin, created_at, updated_at)
             VALUES ($1, $2, $3, $4, NULL, TRUE, TRUE, $5, $5)`,
            [adminUsername, adminUsernameLower, pwHash, adminRoleId, ts]
          );
        }
      }
    }
  } finally {
    client.release();
  }
}

export async function ensureDbReady(): Promise<void> {
  if (!globalForPg.__myshareDbInit) {
    globalForPg.__myshareDbInit = initSchemaAndSeed().catch((err) => {
      // Allow subsequent calls to retry if Aiven was momentarily unreachable/booting.
      globalForPg.__myshareDbInit = undefined;
      throw err;
    });
  }
  return globalForPg.__myshareDbInit;
}

export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: unknown[]
): Promise<QueryResult<T>> {
  await ensureDbReady();
  return getPool().query<T>(text, params);
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  await ensureDbReady();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
