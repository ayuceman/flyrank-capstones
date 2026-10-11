import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { start, stop, closePool, freshTenant, api, generate, eventCount, pool } from "./helpers.js";

before(start);
after(async () => { await stop(); await closePool(); });

test("PROBE 1 - same request twice with one idempotency key -> exactly one usage event, second response mirrors the first", async () => {
  const t = await freshTenant("p1");
  const tokens = { input: 1000, cached_input: 4000, output: 500, reasoning: 1500 };
  const a = await generate(t.api_key, "order-42", tokens);
  const b = await generate(t.api_key, "order-42", tokens);
  assert.equal(a.status, 200, a.text);
  assert.equal(b.status, 200, b.text);
  assert.deepEqual(b.body, a.body, "replay must return the identical stored response");
  assert.equal(a.headers.get("idempotent-replayed"), "false");
  assert.equal(b.headers.get("idempotent-replayed"), "true");
  // one api_call event + one ai_tokens event for the single logical action; not four
  assert.equal(await eventCount(t.id), 2);
  const calls = (await pool.query("SELECT count(*)::int AS n FROM usage_events WHERE tenant_id=$1 AND type='api_call'", [t.id])).rows[0].n;
  assert.equal(calls, 1, "exactly one api_call event");
});

test("PROBE 1b - 20 concurrent retries with the same key still produce one event", async () => {
  const t = await freshTenant("p1b");
  const results = await Promise.all(Array.from({ length: 20 }, () => generate(t.api_key, "burst-1", { output: 10 })));
  assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join(","));
  const bodies = new Set(results.map((r) => r.text));
  assert.equal(bodies.size, 1, "every response identical");
  assert.equal(await eventCount(t.id), 2);
});

test("same key with a different body -> 422, no new event", async () => {
  const t = await freshTenant("reuse");
  await generate(t.api_key, "k", { output: 5 }, "first");
  const r = await generate(t.api_key, "k", { output: 5 }, "second");
  assert.equal(r.status, 422);
  assert.equal(r.body.error, "idempotency_key_reused");
  assert.equal(await eventCount(t.id), 2);
});

test("validation at the boundary: bad input is a clean 400, never a 500, and never metered", async () => {
  const t = await freshTenant("val");
  const cases = [
    [{ prompt: "x" }, undefined, "idempotency_key_required"],                      // no key
    [{}, "a", "invalid_input"],                                                     // no prompt
    [{ prompt: "x", tokens: { output: -1 } }, "b", "invalid_input"],               // negative
    [{ prompt: "x", tokens: { output: 1.5 } }, "c", "invalid_input"],              // not an integer
    [{ prompt: "x", tokens: { nope: 1 } }, "d", "invalid_input"],                  // unknown field
    [{ prompt: "x", extra: true }, "e", "invalid_input"],                          // unknown top-level field
    ["{not json", "f", "invalid_json"],
  ];
  for (const [body, idem, code] of cases) {
    const r = await api("POST", "/generate", { key: t.api_key, idem, body });
    assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status} ${r.text}`);
    assert.equal(r.body.error, code);
  }
  assert.equal(await eventCount(t.id), 0);
});

test("tenants are isolated: no key -> 401, another tenant's usage is invisible", async () => {
  const a = await freshTenant("iso-a");
  const b = await freshTenant("iso-b");
  await generate(a.api_key, "x", { output: 100 });
  assert.equal((await api("GET", "/usage")).status, 401);
  assert.equal((await api("GET", "/usage", { key: "mk_bogus" })).status, 401);
  const ub = (await api("GET", "/usage", { key: b.api_key })).body;
  assert.equal(ub.api_calls.used, 0);
  assert.equal(ub.ai_tokens.used, 0);
  const ua = (await api("GET", "/usage", { key: a.api_key })).body;
  assert.equal(ua.api_calls.used, 1);
  assert.equal(ua.ai_tokens.used, 100);
});
