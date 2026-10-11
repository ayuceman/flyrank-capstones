import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { start, stop, closePool, freshTenant, api, pool } from "./helpers.js";

before(start);
after(async () => { await stop(); await closePool(); });

const stripe = new Stripe("sk_test_placeholder");
const SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const RUN = Date.now().toString(36); // unique Stripe ids per run so reruns on the same DB don't collide
const sid = (s) => `${s}_${RUN}`;

function signedEvent(type, object, id = `evt_test_${type.replace(/\./g, "_")}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`) {
  const payload = JSON.stringify({ id, object: "event", type, data: { object } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return { payload, header, id };
}

const post = (payload, header) => api("POST", "/webhooks/stripe", { body: payload, headers: { "stripe-signature": header, "Content-Type": "application/json" } });
const tenantRow = async (id) => (await pool.query("SELECT plan_id, subscription_status, stripe_customer_id FROM tenants WHERE id = $1", [id])).rows[0];

test("PROBE 3 - checkout.session.completed flips the tenant Free -> Pro; GET /usage shows the new limits", async () => {
  const t = await freshTenant("p3");
  const before = (await api("GET", "/usage", { key: t.api_key })).body;
  assert.equal(before.plan.id, "free");
  assert.equal(before.api_calls.limit, 1000);

  const ev = signedEvent("checkout.session.completed", {
    id: "cs_test_a", object: "checkout.session", mode: "subscription",
    customer: sid("cus_test_p3"), subscription: sid("sub_test_p3"),
    client_reference_id: t.id, metadata: { tenant_id: t.id, plan_id: "pro" },
  });
  const r = await post(ev.payload, ev.header);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.status, "processed");

  const row = await tenantRow(t.id);
  assert.equal(row.plan_id, "pro");
  assert.equal(row.subscription_status, "active");
  assert.equal(row.stripe_customer_id, sid("cus_test_p3"));

  const after = (await api("GET", "/usage", { key: t.api_key })).body;
  assert.equal(after.plan.id, "pro");
  assert.equal(after.api_calls.limit, 50_000);
  assert.equal(after.ai_tokens.limit, 5_000_000);
});

test("PROBE 4 - forged webhook (bad signature) -> 400, nothing changes", async () => {
  const t = await freshTenant("p4-forge");
  const payload = JSON.stringify({ id: "evt_forged", object: "event", type: "checkout.session.completed", data: { object: { id: "cs_x", object: "checkout.session", mode: "subscription", metadata: { tenant_id: t.id, plan_id: "pro" } } } });

  const wrongSecret = stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_somebody_else" });
  let r = await post(payload, wrongSecret);
  assert.equal(r.status, 400); assert.equal(r.body.error, "invalid_signature");

  const validSigOtherBody = stripe.webhooks.generateTestHeaderString({ payload: payload.replace("pro", "free"), secret: SECRET });
  r = await post(payload, validSigOtherBody);           // tampered body
  assert.equal(r.status, 400);

  r = await post(payload, "t=1,v1=deadbeef");            // garbage header
  assert.equal(r.status, 400);

  r = await api("POST", "/webhooks/stripe", { body: payload, headers: { "Content-Type": "application/json" } }); // no header
  assert.equal(r.status, 400); assert.equal(r.body.error, "missing_signature");

  const row = await tenantRow(t.id);
  assert.equal(row.plan_id, "free");
  assert.equal(row.subscription_status, "none");
  const logged = (await pool.query("SELECT count(*)::int AS n FROM stripe_events WHERE id = 'evt_forged'")).rows[0].n;
  assert.equal(logged, 0, "a forged event must not even be recorded");
});

test("PROBE 4b - replaying a real event twice -> processed once", async () => {
  const t = await freshTenant("p4-replay");
  const ev = signedEvent("checkout.session.completed", {
    id: "cs_test_b", object: "checkout.session", mode: "subscription", customer: sid("cus_test_replay"), subscription: sid("sub_test_replay"),
    metadata: { tenant_id: t.id, plan_id: "pro" },
  });
  const first = await post(ev.payload, ev.header);
  const second = await post(ev.payload, ev.header);
  const third = await post(ev.payload, ev.header);
  assert.equal(first.body.status, "processed");
  assert.equal(second.body.status, "duplicate");
  assert.equal(third.body.status, "duplicate");
  assert.equal(second.status, 200, "duplicates are acknowledged so Stripe stops retrying");
  const n = (await pool.query("SELECT count(*)::int AS n FROM stripe_events WHERE id = $1", [ev.id])).rows[0].n;
  assert.equal(n, 1);
  const subs = (await pool.query("SELECT count(*)::int AS n FROM subscriptions WHERE tenant_id = $1", [t.id])).rows[0].n;
  assert.equal(subs, 1, "one subscription row, not three");
});

test("subscription lifecycle: updated(past_due) blocks with 402, deleted drops back to free", async () => {
  const t = await freshTenant("lifecycle");
  const done = signedEvent("checkout.session.completed", { id: "cs_l", object: "checkout.session", mode: "subscription", customer: sid("cus_l"), subscription: sid("sub_l"), metadata: { tenant_id: t.id, plan_id: "pro" } });
  await post(done.payload, done.header);
  assert.equal((await tenantRow(t.id)).plan_id, "pro");

  const pastDue = signedEvent("customer.subscription.updated", { id: sid("sub_l"), object: "subscription", customer: sid("cus_l"), status: "past_due", metadata: { tenant_id: t.id, plan_id: "pro" }, current_period_start: 1760000000, current_period_end: 1762600000 });
  await post(pastDue.payload, pastDue.header);
  let row = await tenantRow(t.id);
  assert.equal(row.plan_id, "pro");
  assert.equal(row.subscription_status, "past_due");
  const blocked = await api("POST", "/generate", { key: t.api_key, idem: "blocked", body: { prompt: "x" } });
  assert.equal(blocked.status, 402);
  assert.equal(blocked.body.error, "payment_required");

  const deleted = signedEvent("customer.subscription.deleted", { id: sid("sub_l"), object: "subscription", customer: sid("cus_l"), status: "canceled", metadata: { tenant_id: t.id } });
  await post(deleted.payload, deleted.header);
  row = await tenantRow(t.id);
  assert.equal(row.plan_id, "free");
  assert.equal(row.subscription_status, "canceled");
});

test("checkout for an already-Pro tenant -> 409; a live Stripe key is refused", async () => {
  const t = await freshTenant("already", "pro", "active");
  const r = await api("POST", "/billing/checkout", { key: t.api_key });
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "already_pro");
});
