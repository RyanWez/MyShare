#!/usr/bin/env node
/**
 * PostgreSQL backup reminder / pg_dump wrapper when DATABASE_URL is configured.
 * Managed Aiven PostgreSQL handles automated backups; this script creates a
 * local custom-format dump when `pg_dump` is installed.
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (fs.existsSync(".env")) {
  for (const line of fs.readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const outDir = process.env.BACKUP_DIR || path.join(process.cwd(), "data", "backups");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dest = path.join(outDir, `myshare-${stamp}.dump`);

execFileSync("pg_dump", ["-Fc", "-f", dest, process.env.DATABASE_URL], { stdio: "inherit" });
console.log("Backup written:", dest);
