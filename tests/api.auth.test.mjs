/**
 * Integration tests against the real dev server and database.
 * Start the app first (npm run dev on :3100), then:
 *   node --test tests/api.auth.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.API_BASE || "http://localhost:3100";

async function postLogin(body, headers = {}) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return res;
}

test("login endpoint is served with real rate-limit + db wiring", async () => {
  const res = await fetch(`${BASE}/api/auth/login`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
});

test("malformed JSON body is rejected with 400", async () => {
  const res = await postLogin("{not json");
  assert.equal(res.status, 400);
});

test("unknown username still runs scrypt (no timing short-circuit) and returns 401", async () => {
  const started = Date.now();
  const res = await postLogin({ username: "no-such-user-xyz", password: "wrong-password" });
  const elapsedMs = Date.now() - started;
  assert.equal(res.status, 401);
  const json = await res.json();
  assert.equal(json.ok, false);
  assert.ok(elapsedMs >= 20, `dummy scrypt work should take >=20ms, took ${elapsedMs}ms`);
});

test("verify-otp requires a session (401 before any OTP work)", async () => {
  const res = await fetch(`${BASE}/api/auth/verify-otp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: "09123456789", otp: "123456" }),
  });
  assert.equal(res.status, 401);
});

test("rotating spoofed X-Forwarded-For does not bypass the per-IP login limit", async () => {
  let saw401 = 0;
  let got429 = null;
  for (let i = 0; i < 12; i++) {
    const res = await postLogin(
      { username: `spoof-probe-${i}`, password: "wrong-password" },
      { "x-forwarded-for": `10.99.0.${i + 10}`, "x-real-ip": `10.98.0.${i + 10}` }
    );
    if (res.status === 401) saw401++;
    if (res.status === 429) {
      got429 = res;
      assert.ok(res.headers.get("retry-after"), "429 must carry Retry-After");
      break;
    }
  }
  assert.ok(got429, `expected a 429 after the shared-bucket limit, saw ${saw401} x 401`);
  assert.ok(saw401 >= 5, "spoofed headers must share one bucket until the limit");
});
