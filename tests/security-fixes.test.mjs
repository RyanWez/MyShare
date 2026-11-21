/**
 * Unit tests for the security fixes in src/lib/rateLimit.ts and the
 * verify-otp phone validation, run with the built-in node:test runner:
 *   node --test tests/
 */
import test from "node:test";
import assert from "node:assert/strict";
import { clientIp, rateLimit, rateLimitReset } from "../src/lib/rateLimit.ts";
import { normalizeMsisdn } from "../src/lib/mytel.ts";

function reqWith(headers) {
  return new Request("https://example.test/api/auth/login", { headers });
}

const PROXY_ENV = ["FLY_APP_NAME", "RENDER", "TRUST_PROXY"];

function clearProxyEnv() {
  for (const k of PROXY_ENV) delete process.env[k];
}

test.afterEach(() => clearProxyEnv());

test("clientIp ignores spoofable headers without a trusted proxy", () => {
  clearProxyEnv();
  const ip = clientIp(
    reqWith({
      "x-forwarded-for": "1.2.3.4, 5.6.7.8",
      "fly-client-ip": "9.9.9.9",
      "cf-connecting-ip": "7.7.7.7",
      "x-real-ip": "6.6.6.6",
    })
  );
  assert.equal(ip, "untrusted-proxy");
});

test("clientIp on Fly trusts only fly-client-ip", () => {
  process.env.FLY_APP_NAME = "myshare";
  const ip = clientIp(
    reqWith({ "fly-client-ip": " 10.0.0.1 ", "x-forwarded-for": "1.2.3.4" })
  );
  assert.equal(ip, "10.0.0.1");
});

test("clientIp on Fly falls back to unknown when header missing", () => {
  process.env.FLY_APP_NAME = "myshare";
  assert.equal(clientIp(reqWith({})), "unknown");
});

test("clientIp prefers cf-connecting-ip behind a trusted proxy", () => {
  process.env.TRUST_PROXY = "true";
  const ip = clientIp(
    reqWith({ "cf-connecting-ip": "2.2.2.2", "x-forwarded-for": "1.1.1.1, 3.3.3.3" })
  );
  assert.equal(ip, "2.2.2.2");
});

test("clientIp takes the rightmost x-forwarded-for entry behind a trusted proxy", () => {
  process.env.TRUST_PROXY = "1";
  const ip = clientIp(reqWith({ "x-forwarded-for": "spoofed.invalid, 3.3.3.3,  4.4.4.4 " }));
  assert.equal(ip, "4.4.4.4");
});

test("clientIp falls back to x-real-ip then unknown behind a trusted proxy", () => {
  process.env.RENDER = "1";
  assert.equal(clientIp(reqWith({ "x-real-ip": "5.5.5.5" })), "5.5.5.5");
  assert.equal(clientIp(reqWith({ "x-forwarded-for": "  " })), "unknown");
});

test("rateLimit peek does not spend, spend enforces the verify-otp phone limit", () => {
  const bucket = "test:otp:verify:phone";
  const key = "959123456789";
  rateLimitReset(bucket, key);

  for (let i = 0; i < 8; i++) {
    const peek = rateLimit(bucket, key, 8, 15 * 60 * 1000, { peek: true });
    assert.equal(peek.allowed, true, `peek ${i} must not be blocked`);
    rateLimit(bucket, key, 8, 15 * 60 * 1000);
  }
  const blocked = rateLimit(bucket, key, 8, 15 * 60 * 1000, { peek: true });
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec > 0 && blocked.retryAfterSec <= 15 * 60);
});

test("rateLimitReset forgives the phone bucket after success", () => {
  const bucket = "test:otp:verify:phone";
  const key = "959987654321";
  rateLimitReset(bucket, key);
  for (let i = 0; i < 8; i++) rateLimit(bucket, key, 8, 15 * 60 * 1000);
  assert.equal(rateLimit(bucket, key, 8, 15 * 60 * 1000, { peek: true }).allowed, false);
  rateLimitReset(bucket, key);
  assert.equal(rateLimit(bucket, key, 8, 15 * 60 * 1000, { peek: true }).allowed, true);
});

test("rateLimit keys are isolated per bucket and per key", () => {
  rateLimit("test:iso:a", "k1", 1, 60 * 1000);
  assert.equal(rateLimit("test:iso:a", "k1", 1, 60 * 1000, { peek: true }).allowed, false);
  assert.equal(rateLimit("test:iso:a", "k2", 1, 60 * 1000, { peek: true }).allowed, true);
  assert.equal(rateLimit("test:iso:b", "k1", 1, 60 * 1000, { peek: true }).allowed, true);
});

test("verify-otp accepts exactly 959XXXXXXXXX after normalizeMsisdn", () => {
  const accept = (s) => /^959\d{9}$/.test(s);
  for (const raw of ["09123456789", "+959123456789", "959123456789", "959 123 456 789"]) {
    const msisdn = normalizeMsisdn(raw);
    assert.ok(accept.call(null, msisdn), `${raw} -> ${msisdn} must pass`);
  }
  for (const bad of ["95912345678", "9591234567890", "12345678901", "not-a-phone"]) {
    const msisdn = normalizeMsisdn(bad);
    assert.ok(!accept.call(null, msisdn), `${bad} -> ${msisdn} must be rejected with 400`);
  }
});
