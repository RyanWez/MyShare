#!/usr/bin/env node
/**
 * PostgreSQL backup reminder / pg_dump wrapper when DATABASE_URL is configured.
 * Managed Aiven PostgreSQL handles automated backups; this script creates a
 * local custom-format dump when `pg_dump` is installed.
 *
 * The password never appears on pg_dump's command line (visible in `ps`):
 * it goes through a mode-0600 pgpass file in a temporary mode-0700 directory.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) {
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[m[1]] = value;
    }
  }
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const dbUrl = new URL(process.env.DATABASE_URL);
const host = dbUrl.hostname;
const port = dbUrl.port || "5432";
const user = decodeURIComponent(dbUrl.username);
const password = decodeURIComponent(dbUrl.password);
const db = decodeURIComponent(dbUrl.pathname.slice(1));
const sslmode = dbUrl.searchParams.get("sslmode");

const outDir = process.env.BACKUP_DIR || path.join(process.cwd(), "data", "backups");
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dest = path.join(outDir, `myshare-${stamp}.dump`);

/** Escape a field for the pgpass format (backslash and colon). */
const escapePgpass = (field) => field.replace(/\\/g, "\\\\").replace(/:/g, "\\:");

let tmpDir;
try {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pgpass-"));
  fs.chmodSync(tmpDir, 0o700);
  const pgpassPath = path.join(tmpDir, ".pgpass");
  const pgpassLine =
    [host, port, db, user, password].map(escapePgpass).join(":") + "\n";
  fs.writeFileSync(pgpassPath, pgpassLine, { mode: 0o600 });

  const env = { ...process.env, PGPASSFILE: pgpassPath };
  if (sslmode) env.PGSSLMODE = sslmode;

  try {
    execFileSync('pg_dump', ['-Fc', '-h', host, '-p', port, '-U', user, '-d', db, '-f', dest], {
      stdio: 'inherit',
      env,
    });
    fs.chmodSync(dest, 0o600);
    console.log("Backup written:", dest);
  } finally {
    fs.rmSync(pgpassPath, { force: true });
  }
} finally {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}
