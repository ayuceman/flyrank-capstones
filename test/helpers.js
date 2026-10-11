// Shared test plumbing: boots the real app against DATABASE_URL (a real
// Postgres), with the worker off so tests drive jobs explicitly.
import { createApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { pool } from "../src/db/pool.js";
import { createTenant } from "../src/services/tenants.js";

process.env.STRIPE_SECRET_KEY ||= "sk_test_placeholder";
process.env.STRIPE_WEBHOOK_SECRET ||= "whsec_test_placeholder_secret";
process.env.ADMIN_KEY ||= "test-admin-key";
delete process.env.ALERT_WEBHOOK_URL;

let server, base;

export async function start() {
  await migrate({ log: () => {} });
  server = createApp().listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;
  return base;
}

export async function stop() {
  await new Promise((r) => server.close(r));
}

export async function closePool() {
  await pool.end();
}

export async function freshTenant(name, plan_id = "free", status) {
  const t = await createTenant({ name: `${name} ${Date.now()}`, plan_id });
  if (status) await pool.query("UPDATE tenants SET subscription_status = $2 WHERE id = $1", [t.id, status]);
  return t;
}

export async function api(method, path, { key, idem, body, headers = {} } = {}) {
  const h = { ...headers };
  if (key) h["X-API-Key"] = key;
  if (idem) h["Idempotency-Key"] = idem;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const res = await fetch(base + path, { method, headers: h, body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, text, headers: res.headers };
}

export const generate = (key, idem, tokens, prompt = "hello") => api("POST", "/generate", { key, idem, body: tokens ? { prompt, tokens } : { prompt } });

export const eventCount = async (tenantId) => (await pool.query("SELECT count(*)::int AS n FROM usage_events WHERE tenant_id = $1", [tenantId])).rows[0].n;

export { pool };
