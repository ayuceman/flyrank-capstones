import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { priceTokens, priceApiCalls, formatMicros } from "../src/services/pricing.js";
import { PRICING } from "../src/config.js";
import { start, stop, closePool, freshTenant, api, generate } from "./helpers.js";

before(start);
after(async () => { await stop(); await closePool(); });

test("PROBE 5 - pinned pricing rules produce the exact expected totals", () => {
  // pinned constants, micro-dollars per 1M tokens
  assert.deepEqual(PRICING.tokens_per_million_micros, { input: 2_500_000, cached_input: 625_000, output: 10_000_000, reasoning: 10_000_000 });
  assert.equal(PRICING.api_call_micros, 2_000);

  // 1,000 input @ $2.50/M = $0.0025 ; 4,000 cached @ $0.625/M = $0.0025 ;
  // 500 output @ $10/M = $0.005 ; 1,500 reasoning @ output rate = $0.015  => $0.025
  const p = priceTokens({ input: 1000, cached_input: 4000, output: 500, reasoning: 1500 });
  assert.deepEqual(p.lines, { input: 2500, cached_input: 2500, output: 5000, reasoning: 15000 });
  assert.equal(p.total_micros, 25_000);
  assert.equal(formatMicros(p.total_micros), "$0.025000");

  // cached input really is cheaper: same 4,000 tokens as fresh input would be 4x the price
  assert.equal(priceTokens({ input: 4000 }).total_micros, 10_000);
  assert.equal(priceTokens({ cached_input: 4000 }).total_micros, 2_500);

  // reasoning tokens are billed exactly like output tokens, not free, not a separate rate
  assert.equal(priceTokens({ reasoning: 1500 }).total_micros, priceTokens({ output: 1500 }).total_micros);

  // categories cannot be summed first: 7,000 "tokens" at any single rate is wrong
  const naive = priceTokens({ input: 7000 }).total_micros;
  assert.notEqual(naive, p.total_micros);

  // rounding happens per category, once, half-up, and stays an integer
  assert.equal(priceTokens({ input: 1 }).total_micros, 3);          // 2.5 -> 3
  assert.equal(priceTokens({ cached_input: 1 }).total_micros, 1);   // 0.625 -> 1
  assert.ok(Number.isInteger(priceTokens({ input: 123457, cached_input: 7, output: 999, reasoning: 1 }).total_micros));

  // big but realistic numbers are still exact: 1M of each
  const big = priceTokens({ input: 1_000_000, cached_input: 1_000_000, output: 1_000_000, reasoning: 1_000_000 });
  assert.equal(big.total_micros, 2_500_000 + 625_000 + 10_000_000 + 10_000_000);

  assert.equal(priceApiCalls(1000), 2_000_000); // 1,000 calls = $2.00
  assert.throws(() => priceTokens({ input: -1 }));
  assert.throws(() => priceTokens({ output: 1.5 }));
});

test("PROBE 5b - GET /usage rollup matches the pinned constants exactly", async () => {
  const t = await freshTenant("p5");
  await generate(t.api_key, "a", { input: 1000, cached_input: 4000, output: 500, reasoning: 1500 });
  await generate(t.api_key, "b", { input: 10_000 });
  await generate(t.api_key, "c"); // call only, no tokens
  const u = (await api("GET", "/usage", { key: t.api_key })).body;
  assert.equal(u.api_calls.used, 3);
  assert.equal(u.ai_tokens.used, 7000 + 10_000);
  assert.equal(u.cost.api_calls_micros, 3 * 2000);
  assert.equal(u.cost.ai_tokens_micros, 25_000 + 25_000);
  assert.equal(u.cost.total_micros, 56_000);
  assert.equal(u.cost.total_display, "$0.056000");
  assert.equal(u.cost.total_cents, 6);
});
