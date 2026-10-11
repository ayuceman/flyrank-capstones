# Usage Metering & Billing Engine

FlyRank Backend AI Engineering capstone. A small multi-tenant service that
answers the three questions every SaaS backend has to get right: how much has
this customer used this month, what does it cost, and are they allowed to do
the next thing. It meters usage exactly once even when requests are retried,
enforces plan quotas with honest 402/429 responses, prices AI tokens with the
real-world rules (cached input is cheaper, reasoning counts as output), and
mirrors Stripe test-mode subscriptions into its own database through
signature-verified, deduplicated webhooks.

- `DESIGN.md` - the one-page design, written before the code
- `EVIDENCE.md` - one proof per requirement, pasted from real runs
- `BUILDLOG.md` - where AI helped, where it was wrong, what I changed
- `capstone.yaml` - run / seed / test commands for the evaluator

## Run it

```bash
cp .env.example .env         # defaults work for docker compose; add Stripe test keys for checkout
docker compose up --build    # postgres + app, migrations run on boot
```

Seed two demo tenants (prints their API keys once):

```bash
docker compose exec app node scripts/seed.js
```

Then:

```bash
export KEY=mk_...   # from the seed output

curl -s -X POST localhost:3000/generate \
  -H "X-API-Key: $KEY" -H "Idempotency-Key: order-42" -H "Content-Type: application/json" \
  -d '{"prompt":"Summarise this ticket","tokens":{"input":1000,"cached_input":4000,"output":500,"reasoning":1500}}'

curl -s localhost:3000/usage -H "X-API-Key: $KEY"
```

Send the first request again with the same `Idempotency-Key`: same response,
`Idempotent-Replayed: true`, and `/usage` does not move.

### Without Docker

Point `DATABASE_URL` at any Postgres 14+ and run `npm install && npm start`.
Migrations apply automatically. `npm run seed` seeds; `npm test` runs the
suite against `DATABASE_URL` (it creates tenants, so use a scratch database).

## Architecture

```
                         ┌──────────────────────────────────────────────────────┐
  client                 │  Express                                             │
  X-API-Key              │                                                      │
  Idempotency-Key        │  routes/            services/            db/        │
 ──POST /generate───────▶│  generate.js ──────▶ metering.record ──▶ pool/tx    │
                         │    zod validate       │ seen key? ─ replay stored   │
                         │    400 names field    │ advisory lock (tenant)      │      ┌───────────┐
                         │                       │ quota check  ─ 402 / 429    │      │ Postgres  │
                         │                       │ price tokens (pricing.js)   │◀────▶│ tenants   │
                         │                       │ insert events + response    │      │ plans     │
                         │                       │ enqueue job   (same tx)     │      │ usage_    │
 ──GET  /usage──────────▶│  usage.js ─────────▶ usage.usageReport (rollup)     │      │  events   │
                         │                                                      │      │ stripe_   │
 ──POST /billing/checkout▶  billing.js ───────▶ billing.createCheckoutSession ─┼─────▶│  events   │
                         │                                                      │      │ jobs      │
  Stripe ─signed──▶      │  webhooks.js (raw body) ─▶ verify sig ─ 400 forged  │      │ alerts    │
   /webhooks/stripe      │                         ─▶ insert stripe_events(id) │      └───────────┘
                         │                            conflict? ─ duplicate    │           ▲
                         │                         ─▶ update tenant plan/status│           │
                         │                                                      │           │
                         │  jobs/worker.js  (polls jobs, SKIP LOCKED) ──────────┼───────────┘
                         │    check_usage_alerts: 80% / 100% once per month,    │
                         │    retries w/ backoff, then status=failed + ALERT    │
                         └──────────────────────────────────────────────────────┘
```

Three paths, as the brief describes them: one metering path (`/generate`),
one read path (`/usage`), one payment-sync path (Checkout → webhook). Routes
only do HTTP; services do the logic; `db/` does SQL; the worker is off the
request path.

## The API

| Method | Path | Auth | What |
|---|---|---|---|
| GET | `/health` | - | db ping |
| GET | `/plans` | - | the two plans and their limits |
| POST | `/tenants` | `X-Admin-Key` | create a tenant; returns the API key once |
| POST | `/generate` | `X-API-Key` + `Idempotency-Key` | the billable action: 1 API call + simulated tokens |
| GET | `/usage` | `X-API-Key` | this month's used / limit / cost (`?period=YYYY-MM` for history) |
| POST | `/billing/checkout` | `X-API-Key` | Stripe Checkout session for Pro, returns `url` |
| POST | `/webhooks/stripe` | `Stripe-Signature` | verified + deduplicated plan sync |

`POST /generate` body: `{ "prompt": "...", "tokens": { "input", "cached_input", "output", "reasoning" } }`,
all token fields optional non-negative integers. The tokens are what a real
model call would have reported back; this service meters numbers, it doesn't
call a model.

### Plans

| Plan | API calls / month | AI tokens / month | Price |
|---|---|---|---|
| free | 1,000 | 100,000 | $0 |
| pro | 50,000 | 5,000,000 | $29 / month (Stripe test mode) |

### The quota rule, in one line

Allowed iff `used + requested <= limit`. The 1,000th Free call succeeds, the
1,001st returns:

```
402 {"error":"upgrade_required","message":"Free plan allows 1000 API calls per month; 1000 used, 1 requested. Upgrade to Pro for a higher limit.", "type":"api_call","used":1000,"limit":1000,"requested":1,"remaining":0}
```

- Free over limit → **402 `upgrade_required`** (there is a plan that would allow it)
- Pro over limit → **429 `quota_exceeded`** + `Retry-After` (seconds to next month)
- subscription `past_due` / `canceled` → **402 `payment_required`**, before usage is even looked at

A request's API call and its tokens are checked together; a rejected request
charges nothing.

### Pricing (pinned in `src/config.js`)

Integer micro-dollars everywhere. $0.002 per API call. Per million tokens:
input $2.50, cached input $0.625, output $10.00, reasoning $10.00 (billed as
output). Each category is priced and rounded on its own, then summed; adding
the token counts first and multiplying once would be wrong, and there's a test
that proves it gives a different number.

## Idempotency

`Idempotency-Key` is required on `/generate` (400 without it). Inside one
transaction, under a per-tenant advisory lock: look the key up → if seen with
the same body hash, return the stored response (`Idempotent-Replayed: true`);
if seen with a different body, `422 idempotency_key_reused`; otherwise check
quota, insert the events and the response, enqueue the alert job. The unique
index on `(tenant_id, idempotency_key)` is the backstop: if two identical
requests race, the loser hits the unique violation, re-reads, and returns the
winner's response. The 20-concurrent-retries test is the proof.

## Stripe (test mode only)

The app refuses to start with a `sk_live_` key. To try the real checkout:

1. In the Stripe test dashboard create a recurring $29/month price and put
   its id in `STRIPE_PRO_PRICE_ID`; put your test secret key in `STRIPE_SECRET_KEY`.
2. `stripe listen --forward-to localhost:3000/webhooks/stripe` and put the
   printed `whsec_...` in `STRIPE_WEBHOOK_SECRET`.
3. `curl -s -X POST localhost:3000/billing/checkout -H "X-API-Key: $KEY"` → open the `url`,
   pay with `4242 4242 4242 4242`, any future expiry.
4. `GET /usage` now shows `plan.id: "pro"` and the Pro limits.

Or skip the browser: `stripe trigger checkout.session.completed --add checkout_session:metadata.tenant_id=<id> --add checkout_session:metadata.plan_id=pro`.

The webhook route reads the raw body (mounted before the JSON parser), checks
the signature, and inserts the event id into `stripe_events` as the very first
step; a replay conflicts on the primary key and is acknowledged as `duplicate`
without touching anything. Handled: `checkout.session.completed`,
`customer.subscription.updated`, `customer.subscription.deleted`.

## Background job

Every usage event enqueues `check_usage_alerts` for the tenant in the same
transaction. The worker (in-process, `JOBS_ENABLED=true`) claims jobs with
`FOR UPDATE SKIP LOCKED`, and when a tenant first crosses 80% or 100% of a
quota in a month it records a `usage_alerts` row and, if `ALERT_WEBHOOK_URL`
is set, POSTs the alert. Delivery failures retry with exponential backoff up
to `max_attempts` (5); after that the job is `failed` and an
`{"event":"ALERT",...}` line goes to stderr. `node src/jobs/worker.js --once`
drains the queue from the shell.

## Tests

```bash
DATABASE_URL=postgres://.../metering_test npm test
```

20 tests, ~4 s, against a real Postgres. They are named after the brief's
acceptance probes (`PROBE 1` … `PROBE 5`) so `EVIDENCE.md` can point at them
directly. Webhook tests sign payloads locally with the webhook secret, so the
real verification code path runs without a network.

## Limitations (honest)

- No proration, invoices or overage billing. A mid-month upgrade applies the
  Pro limits immediately and that's it.
- The worker runs inside the API process; one chatty tenant's writes are
  serialised by the advisory lock. Fine here, not a scaling claim.
- Usage alert delivery is "delete the row and retry" rather than a proper
  outbox; a crash between the POST succeeding and the job being marked done
  could re-send one alert.
- Periods are UTC calendar months. A tenant in another timezone sees the
  reset at an odd hour.
- `GET /usage` recomputes the rollup from `usage_events` each time; at real
  volume you'd keep a running counter per `(tenant, period, type)`.
