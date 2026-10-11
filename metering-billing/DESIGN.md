# Design — Usage Metering & Billing Engine

One page. Written before the code, updated when the code disagreed with it.

## Problem

A SaaS backend needs to answer, per customer (tenant): how much have you used this
month, what does it cost, and are you allowed to do this next thing? And it has to
keep being right when requests are retried, webhooks arrive twice, and someone is
sitting exactly on their limit.

## Scope (deliberately small)

- 2 plans: `free` (1,000 API calls, 100k AI tokens / month) and `pro` (50,000 calls,
  5M tokens / month, $29/month).
- 2 usage types: `api_call` and `ai_tokens`.
- 1 dummy billable endpoint: `POST /generate`. It does not call a model; the caller
  passes simulated token counts, which is exactly what a real integration would
  report back after the model call.
- Stripe in test mode for Free → Pro checkout, mirrored into our DB by verified
  webhooks only.
- Non-goal: invoicing, proration, overage billing, multiple currencies, real AI.

## Data model

```
plans            id (pk, 'free'|'pro'), name, api_calls_limit, ai_tokens_limit,
                 price_cents, stripe_price_id (nullable)
tenants          id uuid pk, name, api_key_hash (sha256, unique), plan_id -> plans,
                 stripe_customer_id, subscription_status ('none'|'active'|'past_due'|'canceled'),
                 created_at
subscriptions    id uuid pk, tenant_id -> tenants, stripe_subscription_id unique,
                 plan_id, status, current_period_start, current_period_end, updated_at
usage_events     id uuid pk, tenant_id, type ('api_call'|'ai_tokens'), quantity int,
                 breakdown jsonb (input/cached_input/output/reasoning for tokens),
                 cost_micros bigint, period char(7) 'YYYY-MM',
                 idempotency_key text, request_hash text, response jsonb, created_at
                 UNIQUE (tenant_id, idempotency_key)      <- the whole idempotency story
                 INDEX (tenant_id, period, type)          <- the rollup query
stripe_events    id text pk (evt_...), type, received_at, processed_at
                 <- a webhook is processed once; replay hits the pk and is ignored
jobs             id, type, payload jsonb, status, attempts, max_attempts, run_at,
                 last_error, created_at, finished_at
usage_alerts     tenant_id, period, type, threshold (80|100), sent_at
                 UNIQUE (tenant_id, period, type, threshold)  <- one alert per threshold per month
```

Money is stored as integer **micro-dollars** (1 USD = 1,000,000). Prices per
million tokens are integers too, so `tokens * price_per_million / 1_000_000` is
integer arithmetic with one rounding step at the end, per category.

Every table with customer data has `tenant_id`, and every query in the service
layer takes a tenant and filters on it. There is no "list all usage" route.

## API surface

```
GET  /plans                          public
GET  /health                         public
POST /tenants                        admin (X-Admin-Key) - create tenant, returns api key once
POST /generate                       tenant (X-API-Key) + Idempotency-Key header   <- the billable one
GET  /usage                          tenant - { period, plan, api_calls{used,limit}, ai_tokens{used,limit}, cost{...} }
POST /billing/checkout               tenant - creates a Stripe Checkout session, returns url
POST /webhooks/stripe                Stripe - raw body, signature verified
```

## Idempotency strategy

`POST /generate` requires an `Idempotency-Key` header (400 without it). The service
hashes the request body. Flow:

1. Look up `(tenant_id, idempotency_key)`.
   - found, same `request_hash` → return the stored `response` with the stored status.
     No new event. Header `Idempotent-Replayed: true`.
   - found, different hash → `422`: same key reused with a different body.
2. Not found → quota check → insert event + response in **one transaction**.
3. If two identical requests race, the unique index makes the second insert fail;
   catch the unique violation, re-read the row, return the stored response.

So "exactly once" is enforced by the database, not by application memory.

## Quota rule (the boundary, written down)

Let `used` be this month's total for the type and `n` the requested quantity.
**Allowed iff `used + n <= limit`.** So on the Free plan call number 1,000 succeeds
and call 1,001 is rejected. The check happens before the event is written; a
rejected request records nothing.

Which status:

- tenant on `free` and over the limit → **402 Payment Required** (`upgrade_required`),
  because there is a plan that would allow it.
- tenant on `pro` and over the limit → **429 Too Many Requests** (`quota_exceeded`)
  with `Retry-After` = seconds until the next month.
- tenant whose subscription is `past_due` or `canceled` → **402** (`payment_required`)
  regardless of usage.

Every rejection body says which limit, used, requested, remaining, and what to do.

## Layers

```
routes/        HTTP only: parse headers, validate body with zod, map service results to status codes
services/      metering (idempotency + quota + cost), pricing (pure math), billing (stripe), usage (rollup)
db/            pool, migrations runner, small query helpers
jobs/          worker loop over the jobs table: usage_alerts (80%/100%), retries, failure alert
```

## Background job

After each usage event the service enqueues `check_usage_alerts` for that tenant.
The worker (same process, `JOBS_ENABLED=true`) computes the rollup and, when a
threshold (80%, 100%) is crossed for the first time this month, writes a
`usage_alerts` row and POSTs to `ALERT_WEBHOOK_URL` if set. Delivery failures retry
with backoff up to `max_attempts`; after that the job is marked `failed` and an
`ALERT: job failed` line is logged. The request path never waits for this.

## Explicit non-goal

No proration. If a tenant upgrades on the 20th, the Pro limits apply immediately
and Stripe charges whatever Stripe charges; this service does not try to compute a
partial month.
