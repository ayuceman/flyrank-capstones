import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start, stop, closePool, freshTenant, api, generate, eventCount, pool } from "./helpers.js";

before(start);
after(async () => { await stop(); await closePool(); });

// Free plan: 1,000 API calls. Rule: allowed iff used + n <= limit.
// Drive a tenant to 999 by inserting events directly (fast), then hit the boundary over HTTP.
async function fillCalls(tenantId, n) {
  await pool.query(
    `INSERT INTO usage_events (tenant_id, type, quantity, cost_micros, period, idempotency_key, request_hash, response_status, response)
     SELECT $1, 'api_call', 1, 2000, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM'), 'fill-' || g, 'h', 200, '{}'::jsonb
       FROM generate_series(1, $2) g`,
    [tenantId, n]
  );
}

test("PROBE 2 - Free tenant at the boundary: call 1,000 allowed, call 1,001 -> 402 upgrade_required with a clear message", async () => {
  const t = await freshTenant("p2-free");
  await fillCalls(t.id, 999);
  const u1 = (await api("GET", "/usage", { key: t.api_key })).body;
  assert.equal(u1.api_calls.used, 999);
  assert.equal(u1.api_calls.remaining, 1);

  const call1000 = await generate(t.api_key, "call-1000");
  assert.equal(call1000.status, 200, "the 1,000th call (used + 1 <= 1000) is allowed");

  const call1001 = await generate(t.api_key, "call-1001");
  assert.equal(call1001.status, 402, call1001.text);
  assert.equal(call1001.body.error, "upgrade_required");
  assert.equal(call1001.body.used, 1000);
  assert.equal(call1001.body.limit, 1000);
  assert.equal(call1001.body.requested, 1);
  assert.match(call1001.body.message, /Upgrade to Pro/);

  // the rejected request recorded nothing
  const u2 = (await api("GET", "/usage", { key: t.api_key })).body;
  assert.equal(u2.api_calls.used, 1000);
  assert.equal(u2.api_calls.remaining, 0);
});

test("PROBE 2b - Pro tenant over its limit -> 429 quota_exceeded with Retry-After", async () => {
  const t = await freshTenant("p2-pro", "pro", "active");
  await fillCalls(t.id, 50_000);
  const r = await generate(t.api_key, "one-more");
  assert.equal(r.status, 429, r.text);
  assert.equal(r.body.error, "quota_exceeded");
  assert.ok(r.body.retry_after_seconds > 0);
  assert.equal(r.headers.get("retry-after"), String(r.body.retry_after_seconds));
  assert.match(r.body.message, /resets/);
});

test("token quota: a single request that would cross the AI-token limit is rejected whole, and the call is not charged either", async () => {
  const t = await freshTenant("tok");
  const ok = await generate(t.api_key, "a", { input: 90_000, output: 9_999 }); // 99,999 of 100,000
  assert.equal(ok.status, 200);
  const exact = await generate(t.api_key, "b", { output: 1 });                 // 100,000 == limit -> allowed
  assert.equal(exact.status, 200);
  const over = await generate(t.api_key, "c", { output: 1 });                  // 100,001 -> rejected
  assert.equal(over.status, 402);
  assert.equal(over.body.type, "ai_tokens");
  assert.equal(over.body.used, 100_000);
  const u = (await api("GET", "/usage", { key: t.api_key })).body;
  assert.equal(u.api_calls.used, 2, "the rejected request did not consume an API call");
  assert.equal(u.ai_tokens.used, 100_000);
});

test("past_due / canceled subscription -> 402 payment_required regardless of usage", async () => {
  for (const status of ["past_due", "canceled"]) {
    const t = await freshTenant(`sub-${status}`, "pro", status);
    const r = await generate(t.api_key, "x");
    assert.equal(r.status, 402, r.text);
    assert.equal(r.body.error, "payment_required");
    assert.equal(await eventCount(t.id), 0);
  }
});
