// Stripe, test mode only. Payment truth lives at Stripe; our DB mirrors it, and
// only through webhooks whose signature we verified.
import Stripe from "stripe";
import { pool, withTransaction } from "../db/pool.js";

let stripe;
export function getStripe() {
  if (!stripe) {
    const key = process.env.STRIPE_SECRET_KEY || "";
    if (key.startsWith("sk_live_")) throw new Error("Refusing to start with a LIVE Stripe key. Test mode only.");
    stripe = new Stripe(key, { apiVersion: "2025-08-27.basil", timeout: 15_000, maxNetworkRetries: 2 });
  }
  return stripe;
}

// Create a Checkout session for the Pro plan. Reuses the tenant's Stripe
// customer if we have one. The tenant id travels in metadata so the webhook
// can map the session back to us without trusting anything client-side.
export async function createCheckoutSession(tenant) {
  if (tenant.plan_id === "pro" && tenant.subscription_status === "active") {
    return { error: { status: 409, code: "already_pro", message: "This tenant is already on Pro." } };
  }
  const base = process.env.APP_BASE_URL || "http://localhost:3000";
  const session = await getStripe().checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: process.env.STRIPE_PRO_PRICE_ID, quantity: 1 }],
    customer: tenant.stripe_customer_id || undefined,
    client_reference_id: tenant.id,
    metadata: { tenant_id: tenant.id, plan_id: "pro" },
    subscription_data: { metadata: { tenant_id: tenant.id, plan_id: "pro" } },
    success_url: `${base}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/billing/cancel`,
  });
  return { session: { id: session.id, url: session.url } };
}

// Verify the signature on a raw webhook body. Throws on a forgery.
export function verifyWebhook(rawBody, signatureHeader) {
  return getStripe().webhooks.constructEvent(rawBody, signatureHeader, process.env.STRIPE_WEBHOOK_SECRET);
}

// Process a verified event exactly once. Returns { status: 'processed' | 'duplicate' | 'ignored' }.
export async function handleWebhookEvent(event) {
  return withTransaction(async (client) => {
    // dedupe: the event id is the primary key. A replay conflicts and we stop here.
    const ins = await client.query(
      "INSERT INTO stripe_events (id, type) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id",
      [event.id, event.type]
    );
    if (ins.rowCount === 0) return { status: "duplicate" };

    let outcome = "ignored";
    switch (event.type) {
      case "checkout.session.completed": outcome = await onCheckoutCompleted(client, event.data.object); break;
      case "customer.subscription.updated": outcome = await onSubscriptionChanged(client, event.data.object); break;
      case "customer.subscription.deleted": outcome = await onSubscriptionDeleted(client, event.data.object); break;
    }
    await client.query("UPDATE stripe_events SET processed_at = now() WHERE id = $1", [event.id]);
    return { status: outcome === "ignored" ? "ignored" : "processed", detail: outcome };
  });
}

const mapStatus = (s) => (["active", "trialing"].includes(s) ? "active" : ["past_due", "unpaid", "incomplete"].includes(s) ? "past_due" : "canceled");
const ts = (sec) => (sec ? new Date(sec * 1000) : null);

async function onCheckoutCompleted(client, session) {
  const tenantId = session.metadata?.tenant_id || session.client_reference_id;
  if (!tenantId || session.mode !== "subscription") return "ignored";
  const planId = session.metadata?.plan_id || "pro";
  const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;

  // a Stripe customer belongs to exactly one tenant. If this one is already attached
  // elsewhere, keep the plan change but don't steal the customer id (and say so).
  let customerToSet = customerId || null;
  if (customerToSet) {
    const owner = await client.query("SELECT id FROM tenants WHERE stripe_customer_id = $1 AND id <> $2", [customerToSet, tenantId]);
    if (owner.rowCount > 0) {
      console.warn(JSON.stringify({ event: "stripe_customer_conflict", customer: customerToSet, tenant: tenantId, owned_by: owner.rows[0].id }));
      customerToSet = null;
    }
  }
  const upd = await client.query(
    "UPDATE tenants SET plan_id = $2, subscription_status = 'active', stripe_customer_id = COALESCE($3, stripe_customer_id) WHERE id = $1",
    [tenantId, planId, customerToSet]
  );
  if (upd.rowCount === 0) return "ignored"; // unknown tenant: nothing to update
  if (subId) {
    await client.query(
      `INSERT INTO subscriptions (tenant_id, stripe_subscription_id, plan_id, status)
       VALUES ($1, $2, $3, 'active')
       ON CONFLICT (stripe_subscription_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = 'active', updated_at = now()`,
      [tenantId, subId, planId]
    );
  }
  return `tenant ${tenantId} -> ${planId} (active)`;
}

async function onSubscriptionChanged(client, sub) {
  const row = await findTenantForSubscription(client, sub);
  if (!row) return "ignored";
  const status = mapStatus(sub.status);
  const planId = sub.metadata?.plan_id || "pro";
  await client.query(
    `INSERT INTO subscriptions (tenant_id, stripe_subscription_id, plan_id, status, current_period_start, current_period_end)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (stripe_subscription_id) DO UPDATE SET status = EXCLUDED.status, plan_id = EXCLUDED.plan_id,
       current_period_start = EXCLUDED.current_period_start, current_period_end = EXCLUDED.current_period_end, updated_at = now()`,
    [row.tenant_id, sub.id, planId, sub.status, ts(sub.current_period_start ?? sub.items?.data?.[0]?.current_period_start), ts(sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end)]
  );
  // active -> keep pro; past_due -> stays pro but blocked (402); canceled -> back to free
  await client.query(
    "UPDATE tenants SET subscription_status = $2, plan_id = CASE WHEN $2 = 'canceled' THEN 'free' ELSE $3 END WHERE id = $1",
    [row.tenant_id, status, planId]
  );
  return `tenant ${row.tenant_id} subscription ${sub.status} -> ${status}`;
}

async function onSubscriptionDeleted(client, sub) {
  const row = await findTenantForSubscription(client, sub);
  if (!row) return "ignored";
  await client.query("UPDATE subscriptions SET status = 'canceled', updated_at = now() WHERE stripe_subscription_id = $1", [sub.id]);
  await client.query("UPDATE tenants SET plan_id = 'free', subscription_status = 'canceled' WHERE id = $1", [row.tenant_id]);
  return `tenant ${row.tenant_id} -> free (canceled)`;
}

async function findTenantForSubscription(client, sub) {
  // prefer our own metadata, then the subscription we already know, then the customer id
  if (sub.metadata?.tenant_id) {
    const r = await client.query("SELECT id AS tenant_id FROM tenants WHERE id = $1", [sub.metadata.tenant_id]);
    if (r.rows[0]) return r.rows[0];
  }
  const bySub = await client.query("SELECT tenant_id FROM subscriptions WHERE stripe_subscription_id = $1", [sub.id]);
  if (bySub.rows[0]) return bySub.rows[0];
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  if (customerId) {
    const r = await client.query("SELECT id AS tenant_id FROM tenants WHERE stripe_customer_id = $1", [customerId]);
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

export { pool };
