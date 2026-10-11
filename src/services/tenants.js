import crypto from "node:crypto";
import { pool } from "../db/pool.js";

export const hashKey = (key) => crypto.createHash("sha256").update(key).digest("hex");

// Creates a tenant and returns the API key exactly once. Only the hash is stored.
export async function createTenant({ name, plan_id = "free" }) {
  const apiKey = "mk_" + crypto.randomBytes(24).toString("base64url");
  const { rows } = await pool.query(
    `INSERT INTO tenants (name, api_key_hash, plan_id) VALUES ($1, $2, $3)
     RETURNING id, name, plan_id, subscription_status, created_at`,
    [name, hashKey(apiKey), plan_id]
  );
  return { ...rows[0], api_key: apiKey };
}

export async function findTenantByApiKey(apiKey) {
  if (!apiKey) return null;
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.plan_id, t.subscription_status, t.stripe_customer_id,
            p.api_calls_limit, p.ai_tokens_limit, p.price_cents
       FROM tenants t JOIN plans p ON p.id = t.plan_id
      WHERE t.api_key_hash = $1`,
    [hashKey(apiKey)]
  );
  return rows[0] || null;
}

export async function getTenant(id) {
  const { rows } = await pool.query(
    `SELECT t.*, p.api_calls_limit, p.ai_tokens_limit FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`,
    [id]
  );
  return rows[0] || null;
}
