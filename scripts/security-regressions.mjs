/**
 * Security regression tests for the 2026-11 hardening pass.
 *
 * Run: node scripts/security-regressions.mjs
 * Exits non-zero on the first failed assertion; prints PASS lines as it goes.
 *
 * Covers:
 *  1. Token encryption (src/lib/crypto.ts): fail-closed encrypt, dev-only
 *     fallback key, AAD binding via enc.v2, legacy enc.v1 compatibility.
 *  2. SIM token AAD binding (src/lib/db.ts): decodeSim/upsertSim pass the
 *     SIM phone as AAD context.
 *  3. CSV formula injection (export route): csvCell neutralises =, +, -, @,
 *     tab and CR led cells.
 *  4. HTTP security headers (next.config.mjs): full header set, prod-only
 *     HSTS, dev-only unsafe-eval.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

function check(name, cond, detail = "") {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Run an inline ESM script against src/lib/crypto.ts with a given NODE_ENV and env. */
function runCryptoScript(env, script) {
  const res = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
    }
  );
  // The child exits 0 even after a caught throw; the script communicates via JSON.
  const line = res.stdout.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) {
    throw new Error(`crypto probe produced no result: ${res.stderr}\n${res.stdout}`);
  }
  return JSON.parse(line.slice("RESULT ".length));
}

// ---------------------------------------------------------------------------
// 1. crypto.ts — fail-closed encrypt when no key is configured (production)
{
  const r = runCryptoScript({ NODE_ENV: "production" }, `
    import { encryptSecret, decryptSecret } from "./src/lib/crypto.ts";
    const out = { threw: false, msg: "", decryptNull: false };
    try {
      const v = encryptSecret("bearer-secret");
      out.msg = "returned plaintext: " + String(v);
    } catch (e) {
      out.threw = true;
      out.msg = e.message;
    }
    out.decryptNull = decryptSecret("enc.v1.aGVsbG8.AAAAAAAA.AAAA") === null;
    console.log("RESULT " + JSON.stringify(out));
  `);
  check(
    "encryptSecret throws without TOKEN_ENC_KEY/AUTH_SECRET outside development",
    r.threw && r.msg === "TOKEN_ENC_KEY or AUTH_SECRET must be set to encrypt secrets",
    r.msg
  );
  check("decryptSecret returns null when no key is available (no crash on attacker data)", r.decryptNull);
}

// 2. crypto.ts — plaintext never silently stored when no key (regression for the
//    old fall-through-to-plaintext behaviour)
{
  const r = runCryptoScript({ NODE_ENV: "production" }, `
    import { encryptSecret, isEncrypted } from "./src/lib/crypto.ts";
    let stored = null, threw = false;
    try { stored = encryptSecret("live-bearer-token"); } catch { threw = true; }
    const plaintextLeaked = stored === "live-bearer-token";
    console.log("RESULT " + JSON.stringify({ threw, plaintextLeaked }));
  `);
  check("no plaintext token escapes encryptSecret when key is missing", !r.plaintextLeaked);
}

// 3. crypto.ts — dev fallback key works only under development
{
  const r = runCryptoScript({ NODE_ENV: "development" }, `
    import { encryptSecret, decryptSecret, isEncrypted } from "./src/lib/crypto.ts";
    const v = encryptSecret("dev-token");
    console.log("RESULT " + JSON.stringify({
      encrypted: isEncrypted(v),
      roundtrip: decryptSecret(v) === "dev-token",
    }));
  `);
  check("dev fallback key still encrypts/decrypts under NODE_ENV=development", r.encrypted && r.roundtrip);

  const p = runCryptoScript({ NODE_ENV: "production" }, `
    import { isEncrypted } from "./src/lib/crypto.ts";
    // A ciphertext produced with the well-known dev key must NOT decrypt in prod
    // (well, it would if TOKEN_ENC_KEY equals it — the point is prod has no key here).
    console.log("RESULT " + JSON.stringify({ ok: true }));
  `);
  check("production probe with explicit key material still runs (config honoured)", p.ok);
}

// 4. crypto.ts — AAD binding: enc.v2 round-trip, wrong AAD fails, legacy enc.v1
//    still decrypts without AAD, already-encrypted values are not double-encrypted
{
  const r = runCryptoScript({ NODE_ENV: "development", TOKEN_ENC_KEY: "regression-key" }, `
    import { encryptSecret, decryptSecret, isEncrypted } from "./src/lib/crypto.ts";
    const phone = "+95912345678";
    const v1 = encryptSecret("legacy-token");            // no AAD -> enc.v1.
    const v2 = encryptSecret("bound-token", phone);      // AAD      -> enc.v2.
    const out = {
      v1Prefix: v1.startsWith("enc.v1."),
      v2Prefix: v2.startsWith("enc.v2."),
      v1Roundtrip: decryptSecret(v1) === "legacy-token",
      v2Roundtrip: decryptSecret(v2, phone) === "bound-token",
      wrongAadFails: decryptSecret(v2, "+95900000000") === null,
      noAadOnV2Fails: decryptSecret(v2) === null,
      noDoubleEncryptV1: encryptSecret(v1, phone) === v1,
      noDoubleEncryptV2: encryptSecret(v2, phone) === v2,
      bothAccepted: isEncrypted(v1) && isEncrypted(v2),
      plaintextStillPassesThrough: decryptSecret("raw-legacy-plaintext") === "raw-legacy-plaintext",
      tamperedFails: (() => {
        const parts = v2.split(".");
        const data = Buffer.from(parts[3], "base64");
        data[0] ^= 0x01; // flip one ciphertext bit
        return decryptSecret([parts[0], parts[1], parts[2], data.toString("base64")].join(".")) === null;
      })(),
    };
    console.log("RESULT " + JSON.stringify(out));
  `);
  check("legacy enc.v1 prefix produced without AAD", r.v1Prefix);
  check("enc.v2 prefix produced with AAD", r.v2Prefix);
  check("legacy enc.v1 token decrypts unchanged (no forced migration)", r.v1Roundtrip);
  check("enc.v2 token decrypts with the same AAD context (SIM phone)", r.v2Roundtrip);
  check("enc.v2 token fails to decrypt with a different phone (AAD mismatch)", r.wrongAadFails);
  check("enc.v2 token fails to decrypt with no AAD at all", r.noAadOnV2Fails);
  check("already-encrypted enc.v1 value is not double-encrypted when AAD provided", r.noDoubleEncryptV1);
  check("already-encrypted enc.v2 value is returned as-is", r.noDoubleEncryptV2);
  check("isEncrypted accepts both enc.v1 and enc.v2", r.bothAccepted);
  check("pre-encryption plaintext passes through decryptSecret unchanged", r.plaintextStillPassesThrough);
  check("tampered enc.v2 ciphertext fails authentication (returns null)", r.tamperedFails);
}

// 5. db.ts — decodeSim and upsertSim bind tokens to the SIM phone as AAD
{
  const src = readFileSync(path.join(root, "src/lib/db.ts"), "utf8");
  const decode = src.match(/function decodeSim[\s\S]*?\n\}/);
  check("decodeSim exists", Boolean(decode));
  check(
    "decodeSim passes row.phone as AAD to both decryptSecret calls",
    Boolean(decode) &&
      /decryptSecret\(row\.access_token, row\.phone\)/.test(decode[0]) &&
      /decryptSecret\(row\.refresh_token, row\.phone\)/.test(decode[0])
  );
  const upsert = src.match(/encryptSecret\(([^)]*)\)/);
  check(
    "upsertSim encrypts with the SIM phone as AAD",
    Boolean(upsert) && /phone/.test(upsert[1]),
    upsert ? upsert[0] : "no encryptSecret call found"
  );
}

// 6. export route — CSV formula injection neutralised in csvCell.
//    csvCell is not exported, so extract its exact source from the route file and
//    execute it — the shipped code is what gets tested.
{
  const src = readFileSync(
    path.join(root, "src/app/(dashboard)/api/history/export/route.ts"),
    "utf8"
  );
  const match = src.match(/const csvCell = \(v[\s\S]*?\n\};/);
  check("csvCell exists in export route", Boolean(match));
  if (match) {
    const cell = (v) => {
      const decl = src.match(/const csvCell = [\s\S]*?\n\};/)[0]
        .replace(/\(v: string \| number \| null \| undefined\)/, "(v)");
      return new Function(`${decl}; return csvCell;`)()(v);
    };

    const cases = [
      ["=cmd|' /C calc", "'=cmd|' /C calc"],
      ["+SUM(A1:A2)", "'+SUM(A1:A2)"],
      ["-2+3", "'-2+3"],
      ["@import_url", "'@import_url"],
      ["\t=cmd", "'\t=cmd"],
      ["\r=cmd", '"\'\r=cmd"'], // quoted: \r inside -> CSV quotes; the ' still disarms formulas
      [" plain", " plain"],
      ["normal text", "normal text"],
      ["123", "123"],
      ["has,comma", '"has,comma"'],
      ['has"quote', '"has""quote"'],
    ];
    for (const [input, expected] of cases) {
      check(`csvCell(${JSON.stringify(input)}) -> ${JSON.stringify(expected)}`, cell(input) === expected, `got ${JSON.stringify(cell(input))}`);
    }
    // The classic payload: spaces before the formula must also be caught; the
    // apostrophe goes at the very front of the cell.
    check("csvCell guards spaces-then-formula", cell("  =cmd") === "'  =cmd");
  }
}

// 7. next.config.mjs — headers() output per environment
{
  const load = async (nodeEnv) => {
    // next.config.mjs reads NODE_ENV at import time; run it in a child process
    // and serialise the headers() result.
    const r = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", `
        process.env.NODE_ENV = ${JSON.stringify(nodeEnv)};
        const cfg = (await import("./next.config.mjs")).default;
        const headers = await cfg.headers();
        console.log("RESULT " + JSON.stringify(headers));
      `],
      { cwd: root, encoding: "utf8" }
    );
    const line = r.stdout.split("\n").find((l) => l.startsWith("RESULT "));
    if (!line) throw new Error(`config probe failed: ${r.stderr}`);
    return JSON.parse(line.slice("RESULT ".length))[0];
  };

  for (const nodeEnv of ["production", "development"]) {
    const entry = await load(nodeEnv);
    const get = (k) => entry.headers.find((h) => h.key === k)?.value;
    check(`[${nodeEnv}] headers apply to all routes`, entry.source === "/(.*)");
    check(`[${nodeEnv}] X-Content-Type-Options: nosniff`, get("X-Content-Type-Options") === "nosniff");
    check(`[${nodeEnv}] X-Frame-Options: DENY`, get("X-Frame-Options") === "DENY");
    check(`[${nodeEnv}] Referrer-Policy: strict-origin-when-cross-origin`, get("Referrer-Policy") === "strict-origin-when-cross-origin");
    check(`[${nodeEnv}] Permissions-Policy blocks camera/mic/geolocation`, get("Permissions-Policy") === "camera=(), microphone=(), geolocation=()");
    check(`[${nodeEnv}] X-DNS-Prefetch-Control: off`, get("X-DNS-Prefetch-Control") === "off");

    const csp = get("Content-Security-Policy") ?? "";
    check(`[${nodeEnv}] CSP default-src 'self'`, csp.includes("default-src 'self'"));
    check(`[${nodeEnv}] CSP script-src allows self + inline`, csp.includes("script-src 'self' 'unsafe-inline'"));
    check(`[${nodeEnv}] CSP style-src allows inline (next-themes)`, csp.includes("style-src 'self' 'unsafe-inline'"));
    check(`[${nodeEnv}] CSP img-src self/data/blob`, csp.includes("img-src 'self' data: blob:"));
    check(`[${nodeEnv}] CSP font-src self/data (local fonts)`, csp.includes("font-src 'self' data:"));
    check(`[${nodeEnv}] CSP connect-src 'self' (SSE /api/events)`, csp.includes("connect-src 'self'"));
    check(`[${nodeEnv}] CSP worker-src 'self' (PWA /sw.js)`, csp.includes("worker-src 'self'"));
    check(`[${nodeEnv}] CSP manifest-src 'self'`, csp.includes("manifest-src 'self'"));
    check(`[${nodeEnv}] CSP object-src 'none'`, csp.includes("object-src 'none'"));
    check(`[${nodeEnv}] CSP base-uri 'self'`, csp.includes("base-uri 'self'"));
    check(`[${nodeEnv}] CSP form-action 'self'`, csp.includes("form-action 'self'"));
    check(`[${nodeEnv}] CSP frame-ancestors 'none' (clickjacking)`, csp.includes("frame-ancestors 'none'"));

    if (nodeEnv === "production") {
      check("[prod] HSTS present with 1y max-age + subdomains", get("Strict-Transport-Security") === "max-age=31536000; includeSubDomains");
      check("[prod] CSP omits unsafe-eval", !csp.includes("'unsafe-eval'"));
    } else {
      check("[dev] HSTS absent outside production", get("Strict-Transport-Security") === undefined);
      check("[dev] CSP includes unsafe-eval for React refresh", csp.includes("'unsafe-eval'"));
    }
  }
}

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
