// Rollups: what has this tenant used this month, and what does it cost.
import { pool } from "../db/pool.js";
import { periodOf, secondsUntilNextPeriod } from "../config.js";
import { formatMicros, microsToCents } from "./pricing.js";

// Totals by type for one tenant and period. `client` lets the metering
// transaction read its own view.
export async function totals(tenantId, period = periodOf(), client = pool) {
  const { rows } = await client.query(
    `SELECT type, COALESCE(SUM(quantity), 0)::bigint AS used, COALESCE(SUM(cost_micros), 0)::bigint AS cost_micros,
            COUNT(*)::int AS events
       FROM usage_events WHERE tenant_id = $1 AND period = $2 GROUP BY type`,
    [tenantId, period]
  );
  const out = { api_call: { used: 0, cost_micros: 0, events: 0 }, ai_tokens: { used: 0, cost_micros: 0, events: 0 } };
  for (const r of rows) out[r.type] = { used: r.used, cost_micros: r.cost_micros, events: r.events };
  return out;
}

export async function usageReport(tenant, period = periodOf()) {
  const t = await totals(tenant.id, period);
  const apiCost = t.api_call.cost_micros;
  const tokCost = t.ai_tokens.cost_micros;
  const total = apiCost + tokCost;
  return {
    tenant_id: tenant.id,
    period,
    period_resets_in_seconds: secondsUntilNextPeriod(),
    plan: { id: tenant.plan_id, subscription_status: tenant.subscription_status },
    api_calls: { used: t.api_call.used, limit: tenant.api_calls_limit, remaining: Math.max(0, tenant.api_calls_limit - t.api_call.used) },
    ai_tokens: { used: t.ai_tokens.used, limit: tenant.ai_tokens_limit, remaining: Math.max(0, tenant.ai_tokens_limit - t.ai_tokens.used) },
    cost: {
      api_calls_micros: apiCost,
      ai_tokens_micros: tokCost,
      total_micros: total,
      total_cents: microsToCents(total),
      total_display: formatMicros(total),
      currency: "USD",
    },
  };
}
