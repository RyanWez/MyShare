/**
 * End-to-end test for scripts/backup-db.js using a stub pg_dump binary, so the
 * real .env parsing, URL parsing, pgpass handling and cleanup run unmodified.
 * Run with: node --test tests/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dirname, "../scripts/backup-db.js");

function makeShim(captureFile) {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "pgshim-"));
  fs.writeFileSync(
    path.join(shimDir, "pg_dump"),
    `#!/usr/bin/env bash
{
  echo "ARGS:$*"
  echo "PGPASSFILE:$PGPASSFILE"
  echo "PGSSLMODE:$PGSSLMODE"
  echo "PGPASS_CONTENTS:$(cat "$PGPASSFILE")"
} > "$CAPTURE"
dest=""
prev=""
for arg in "$@"; do
  [ "$prev" = "-f" ] && dest="$arg"
  prev="$arg"
done
[ -n "$dest" ] && echo "fake-dump" > "$dest"
`,
    { mode: 0o755 }
  );
  return shimDir;
}

function runBackup(env, cwd) {
  return execFileSync("node", [SCRIPT], { env, cwd, stdio: "pipe" }).toString();
}

test("backup-db passes the password via pgpass, never via argv", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const capture = path.join(base, "capture.txt");
  const shimDir = makeShim(capture);
  t.after(() => fs.rmSync(shimDir, { recursive: true, force: true }));

  const outDir = path.join(base, "out");
  // Password contains a colon and a backslash; URL-encoded in DATABASE_URL.
  const databaseUrl =
    "postgres://user:pa%3Ass%5Cwd@db.example.test:5433/mydb?sslmode=require";
  runBackup(
    {
      ...process.env,
      DATABASE_URL: databaseUrl,
      BACKUP_DIR: outDir,
      CAPTURE: capture,
      PATH: `${shimDir}:${process.env.PATH}`,
    },
    base
  );

  const captured = fs.readFileSync(capture, "utf8");
  const lines = Object.fromEntries(
    captured
      .trim()
      .split("\n")
      .map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1)])
  );

  assert.match(lines.ARGS, /^-Fc -h db\.example\.test -p 5433 -U user -d mydb -f /);
  assert.ok(!lines.ARGS.includes("pa:"), "raw password must not appear in argv");
  assert.ok(!lines.ARGS.includes("PGPASSFILE"), "pgpass path must not appear in argv");
  assert.equal(lines.PGSSLMODE, "require");

  assert.ok(lines.PGPASSFILE, "PGPASSFILE must be set for pg_dump");
  assert.ok(!fs.existsSync(lines.PGPASSFILE), "pgpass file must be deleted afterwards");
  assert.equal(lines.PGPASS_CONTENTS, "db.example.test:5433:mydb:user:pa\\:ss\\\\wd");

  const pgpassDir = path.dirname(lines.PGPASSFILE);
  assert.ok(pgpassDir.startsWith(os.tmpdir()));
  assert.ok(!fs.existsSync(pgpassDir), "temp pgpass dir must be removed");

  const dumps = fs.readdirSync(outDir).filter((f) => f.endsWith(".dump"));
  assert.equal(dumps.length, 1);
  const mode = fs.statSync(path.join(outDir, dumps[0])).mode & 0o777;
  assert.equal(mode.toString(8), "600", "dump file must be chmod 0600");
  const dirMode = fs.statSync(outDir).mode & 0o777;
  assert.ok(dirMode === 0o700 || (dirMode & 0o077) === 0, "outDir must not be group/world accessible");
});

test("backup-db reads DATABASE_URL from .env, stripping surrounding quotes", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const capture = path.join(base, "capture.txt");
  const shimDir = makeShim(capture);
  t.after(() => fs.rmSync(shimDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(base, ".env"),
    '# comment line\nDATABASE_URL="postgres://envuser:envpass@db.env.test:6543/envdb?sslmode=require"\n'
  );

  const outDir = path.join(base, "out2");
  runBackup(
    {
      ...process.env,
      DATABASE_URL: "",
      BACKUP_DIR: outDir,
      CAPTURE: capture,
      PATH: `${shimDir}:${process.env.PATH}`,
    },
    base
  );

  const captured = fs.readFileSync(capture, "utf8");
  assert.match(captured, /ARGS:-Fc -h db\.env\.test -p 6543 -U envuser -d envdb/);
  assert.match(captured, /PGPASS_CONTENTS:db\.env\.test:6543:envdb:envuser:envpass/);
  assert.ok(!captured.includes("ARGS:.*envpass"), "password must not be in argv");
});

test("backup-db fails with a clear error when DATABASE_URL is missing", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  assert.throws(
    () =>
      execFileSync("node", [SCRIPT], {
        cwd: base,
        env: { ...process.env, DATABASE_URL: "" },
        stdio: "pipe",
      }),
    /DATABASE_URL is not set/
  );
});
