// The heart of it: record one billable action exactly once, after checking the
// tenant is allowed to do it.
//
//   result = await meter.record({ tenant, idempotencyKey, request, buildResponse })
//
// returns { status, body, replayed, events } where status is the HTTP status
// the route should send. Quota rejections are results too (402/429), not
// exceptions, because they're normal outcomes that must be explainable.
import crypto from "node:crypto";
import { pool, withTransaction } from "../db/pool.js";
import { periodOf, secondsUntilNextPeriod } from "../config.js";
import { priceApiCalls, priceTokens, normalizeBreakdown } from "./pricing.js";
import { totals } from "./usage.js";
import { enqueue } from "../jobs/queue.js";

const hashRequest = (obj) => crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");

// Decide allow/reject for a tenant wanting `n` more of `type` this period.
// The rule, written down in DESIGN.md: allowed iff used + n <= limit.
export function checkQuota({ tenant, used, type, n }) {
  const limit = type === "api_call" ? tenant.api_calls_limit : tenant.ai_tokens_limit;

  if (tenant.subscription_status === "past_due" || tenant.subscription_status === "canceled") {
    return reject(402, "payment_required", `Subscription is ${tenant.subscription_status}. Update your payment method to continue.`, { type, used, limit, requested: n });
  }
  if (used + n <= limit) return { allowed: true, limit, remaining: limit - used - n };

  const detail = { type, used, limit, requested: n, remaining: Math.max(0, limit - used) };
  if (tenant.plan_id === "free") {
    return reject(402, "upgrade_required", `Free plan allows ${limit} ${label(type)} per month; ${used} used, ${n} requested. Upgrade to Pro for a higher limit.`, detail);
  }
  return reject(429, "quota_exceeded", `Plan allows ${limit} ${label(type)} per month; ${used} used, ${n} requested. Quota resets at the start of next month.`, {
    ...detail,
    retry_after_seconds: secondsUntilNextPeriod(),
  });
}
const label = (t) => (t === "api_call" ? "API calls" : "AI tokens");
const reject = (status, code, message, detail) => ({ allowed: false, status, body: { error: code, message, ...detail } });

async function findExisting(client, tenantId, key) {
  const { rows } = await client.query(
    `SELECT request_hash, response_status, response FROM usage_events
      WHERE tenant_id = $1 AND idempotency_key = $2 AND type = 'api_call' LIMIT 1`,
    [tenantId, key]
  );
  return rows[0] || null;
}

export async function record({ tenant, idempotencyKey, request, buildResponse }) {
  const requestHash = hashRequest(request);
  const period = periodOf();

  // 1. fast path: have we seen this key?
  const seen = await findExisting(pool, tenant.id, idempotencyKey);
  if (seen) return replay(seen, requestHash);

  const breakdown = normalizeBreakdown(request.tokens);
  const tokenPrice = priceTokens(breakdown);

  try {
    const result = await withTransaction(async (client) => {
      // serialize per tenant so two racing requests can't both pass the quota check
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [tenant.id]);

      // re-check inside the lock (another request with this key may have just committed)
      const again = await findExisting(client, tenant.id, idempotencyKey);
      if (again) return { replayedRow: again };

      const t = await totals(tenant.id, period, client);

      // 2. quota, before anything is written. one call + its tokens are checked together.
      const callCheck = checkQuota({ tenant, used: t.api_call.used, type: "api_call", n: 1 });
      if (!callCheck.allowed) return { rejected: callCheck };
      if (tokenPrice.total_tokens > 0) {
        const tokCheck = checkQuota({ tenant, used: t.ai_tokens.used, type: "ai_tokens", n: tokenPrice.total_tokens });
        if (!tokCheck.allowed) return { rejected: tokCheck };
      }

      // 3. do the "work" and store the response alongside the events, same transaction
      const callCost = priceApiCalls(1);
      const body = buildResponse({
        usage: {
          api_calls: { charged: 1, cost_micros: callCost },
          ai_tokens: { ...breakdown, total: tokenPrice.total_tokens, cost_micros: tokenPrice.total_micros, lines: tokenPrice.lines },
          total_cost_micros: callCost + tokenPrice.total_micros,
        },
      });

      const insert = `INSERT INTO usage_events (tenant_id, type, quantity, breakdown, cost_micros, period, idempotency_key, request_hash, response_status, response)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`;
      await client.query(insert, [tenant.id, "api_call", 1, null, callCost, period, idempotencyKey, requestHash, 200, body]);
      let events = 1;
      if (tokenPrice.total_tokens > 0) {
        // same key, second row of a different type: the unique index is on (tenant, key)
        // so the token event uses a derived key. The replay lookup only needs the first row.
        await client.query(insert, [tenant.id, "ai_tokens", tokenPrice.total_tokens, breakdown, tokenPrice.total_micros, period, `${idempotencyKey}:tokens`, requestHash, 200, body]);
        events = 2;
      }

      await enqueue(client, "check_usage_alerts", { tenant_id: tenant.id, period });

      // return what was stored, not what was built: replays read the jsonb column, and
      // jsonb normalises key order, so this keeps the first response byte-identical to every replay
      const stored = await findExisting(client, tenant.id, idempotencyKey);
      return { body: stored.response, events };
    });

    if (result.replayedRow) return replay(result.replayedRow, requestHash);
    if (result.rejected) return { status: result.rejected.status, body: result.rejected.body, replayed: false, events: 0 };
    return { status: 200, body: result.body, replayed: false, events: result.events };
  } catch (e) {
    // 23505 = unique_violation: a racing request with the same key won. Return its answer.
    if (e.code === "23505") {
      const row = await findExisting(pool, tenant.id, idempotencyKey);
      if (row) return replay(row, requestHash);
    }
    throw e;
  }
}

function replay(row, requestHash) {
  if (row.request_hash !== requestHash) {
    return {
      status: 422,
      replayed: false,
      events: 0,
      body: { error: "idempotency_key_reused", message: "This Idempotency-Key was already used with a different request body. Use a new key for a new request." },
    };
  }
  return { status: row.response_status, body: row.response, replayed: true, events: 0 };
}
