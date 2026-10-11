// Job: after a usage event, see whether the tenant crossed 80% or 100% of a
// quota this month, and if so (and we haven't said so already) send an alert.
import { pool } from "../db/pool.js";
import { ALERT_THRESHOLDS } from "../config.js";
import { getTenant } from "../services/tenants.js";
import { totals } from "../services/usage.js";

export async function checkUsageAlerts({ tenant_id, period }, { log = console.log } = {}) {
  const tenant = await getTenant(tenant_id);
  if (!tenant) return "tenant gone";
  const t = await totals(tenant_id, period);
  const checks = [
    { type: "api_call", used: t.api_call.used, limit: tenant.api_calls_limit },
    { type: "ai_tokens", used: t.ai_tokens.used, limit: tenant.ai_tokens_limit },
  ];

  const sent = [];
  for (const c of checks) {
    if (c.limit === 0) continue;
    const pct = Math.floor((c.used * 100) / c.limit);
    for (const threshold of ALERT_THRESHOLDS) {
      if (pct < threshold) continue;
      // one alert per (tenant, period, type, threshold). The PK makes a repeat a no-op.
      const ins = await pool.query(
        "INSERT INTO usage_alerts (tenant_id, period, type, threshold) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING threshold",
        [tenant_id, period, c.type, threshold]
      );
      if (ins.rowCount === 0) continue;
      const alert = { event: "usage_alert", tenant_id, tenant: tenant.name, period, type: c.type, threshold, used: c.used, limit: c.limit, percent: pct };
      log(JSON.stringify(alert));
      await deliver(alert);
      sent.push(`${c.type}@${threshold}%`);
    }
  }
  return sent.length ? `sent ${sent.join(", ")}` : "no new thresholds";
}

// Optional outbound notification. If the URL is set and the POST fails, we throw
// so the worker retries the whole job; the usage_alerts row stays, which is
// fine because the next attempt only re-delivers what it couldn't deliver...
// except it can't tell. So: delete the row on delivery failure so the retry
// re-sends. Small and honest rather than a full outbox.
async function deliver(alert) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(alert), signal: AbortSignal.timeout(5000) });
  } catch (e) {
    await undoAlert(alert);
    throw new Error(`alert delivery failed: ${e.message}`);
  }
  if (!res.ok) {
    await undoAlert(alert);
    throw new Error(`alert delivery failed: HTTP ${res.status}`);
  }
}

const undoAlert = (a) => pool.query("DELETE FROM usage_alerts WHERE tenant_id=$1 AND period=$2 AND type=$3 AND threshold=$4", [a.tenant_id, a.period, a.type, a.threshold]);
