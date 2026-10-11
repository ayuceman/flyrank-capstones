# EVIDENCE

One proof per requirement checkbox from Section 6 of the brief. Everything
below is pasted from real runs on 2026-10-11, against PostgreSQL 16. The test
suite (`npm test`) is 20 tests, each named after the probe or requirement it
proves, so the test output is most of the evidence.

## On my machine: `bash scripts/smoke.sh` against the Docker stack

Run on 2026-10-11 on macOS with `docker compose up --build`:

```
0. Service
  ok   GET /health reachable at http://localhost:3000
1. Create a tenant
  ok   tenant created, key starts with mk_
  ok   GET /usage shows plan free, 0 used
2. Probe 1 - idempotency
  ok   first call: Idempotent-Replayed: false
  ok   retry:      Idempotent-Replayed: true
  ok   retry body is byte-identical to the first
  ok   only ONE api call metered after two requests
  ok   same key + different body -> 422
3. Probe 5 - pricing
  ok   tokens priced at 25,000 micro$ (2500 + 2500 + 5000 + 15000)
  ok   plus 2,000 for the call = 27,000 micro$
  ok   GET /usage shows $0.027000
4. Validation
  ok   no Idempotency-Key -> 400
  ok   negative tokens -> 400
  ok   bad JSON -> 400
  ok   no API key -> 401
5. Probe 2 - quota boundary (sending 999 calls, ~10-20s)
  ok   1,000 of 1,000 used (the 1,000th call was allowed)
  ok   call 1,001 -> 402 upgrade_required
  {"error":"upgrade_required","message":"Free plan allows 1000 API calls per month; 1000 used, 1 requested. Upgrade to Pro for a higher limit.","type":"api_call","used":1000,"limit":1000,"requested":1,"remaining":0}
  ok   rejected call recorded nothing
6. Probe 4 - forged webhook
  ok   bad signature -> 400
  ok   missing signature -> 400
Result: 20 passed, 0 failed
```

## Full test run (`npm test`, real Postgres)

```
$ npm test
ok 1 - PROBE 1 - same request twice with one idempotency key -> exactly one usage event, second response mirrors the first
ok 2 - PROBE 1b - 20 concurrent retries with the same key still produce one event
ok 3 - same key with a different body -> 422, no new event
ok 4 - validation at the boundary: bad input is a clean 400, never a 500, and never metered
ok 5 - tenants are isolated: no key -> 401, another tenant's usage is invisible
ok 6 - PROBE 2 - Free tenant at the boundary: call 1,000 allowed, call 1,001 -> 402 upgrade_required with a clear message
ok 7 - PROBE 2b - Pro tenant over its limit -> 429 quota_exceeded with Retry-After
ok 8 - token quota: a single request that would cross the AI-token limit is rejected whole, and the call is not charged either
ok 9 - past_due / canceled subscription -> 402 payment_required regardless of usage
ok 10 - PROBE 5 - pinned pricing rules produce the exact expected totals
ok 11 - PROBE 5b - GET /usage rollup matches the pinned constants exactly
ok 12 - PROBE 3 - checkout.session.completed flips the tenant Free -> Pro; GET /usage shows the new limits
ok 13 - PROBE 4 - forged webhook (bad signature) -> 400, nothing changes
ok 14 - PROBE 4b - replaying a real event twice -> processed once
ok 15 - subscription lifecycle: updated(past_due) blocks with 402, deleted drops back to free
ok 16 - checkout for an already-Pro tenant -> 409; a live Stripe key is refused
ok 17 - a usage event enqueues a job; the request does not wait for it
ok 18 - usage alerts fire once at 80% and once at 100%, never twice
ok 19 - delivery failure retries with backoff, then marks the job failed and raises an ALERT
ok 20 - unknown job types fail cleanly without taking the worker down
# tests 20
# pass 20
# fail 0
# duration_ms 4092.239791
```

---

## Metering

**[x] A billable action creates exactly one usage event, even under retries, deduplicated by idempotency key.**

Test: `PROBE 1 - same request twice with one idempotency key -> exactly one usage event, second response mirrors the first` (ok)
Test: `PROBE 1b - 20 concurrent retries with the same key still produce one event` (ok)

**[x] Proof that double-counting cannot happen: a transcript of the same request sent twice.**

```
$ curl -s -X POST localhost:3000/tenants -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" -d '{"name":"Demo Co"}'
{"id":"a0c4b656-6cd6-4cd2-b9c8-8a1fd0d7a3c3","name":"Demo Co","plan_id":"free","subscription_status":"none","created_at":"2026-10-11T07:33:49.831Z","api_key":"mk_...(shown once)"}

$ curl -si -X POST localhost:3000/generate -H "X-API-Key: $KEY" -H "Idempotency-Key: order-42" -H "Content-Type: application/json" \
    -d '{"prompt":"Summarise this ticket","tokens":{"input":1000,"cached_input":4000,"output":500,"reasoning":1500}}'
HTTP/1.1 200 OK
Idempotent-Replayed: false
{"id":"gen_order-42","usage":{"ai_tokens":{"input":1000,"lines":{"input":2500,"output":5000,"reasoning":15000,"cached_input":2500},"total":7000,"output":500,"reasoning":1500,"cost_micros":25000,"cached_input":4000},"api_calls":{"charged":1,"cost_micros":2000},"total_cost_micros":27000},"output":"Generated 500 output tokens for: Summarise this ticket"}

$ # exact same request again (a client retry)
HTTP/1.1 200 OK
Idempotent-Replayed: true
{"id":"gen_order-42","usage":{"ai_tokens":{"input":1000,"lines":{"input":2500,"output":5000,"reasoning":15000,"cached_input":2500},"total":7000,"output":500,"reasoning":1500,"cost_micros":25000,"cached_input":4000},"api_calls":{"charged":1,"cost_micros":2000},"total_cost_micros":27000},"output":"Generated 500 output tokens for: Summarise this ticket"}

$ curl -s localhost:3000/usage -H "X-API-Key: $KEY"
{"tenant_id":"a0c4b656-6cd6-4cd2-b9c8-8a1fd0d7a3c3","period":"2026-10","period_resets_in_seconds":1787171,"plan":{"id":"free","subscription_status":"none"},"api_calls":{"used":1,"limit":1000,"remaining":999},"ai_tokens":{"used":7000,"limit":100000,"remaining":93000},"cost":{"api_calls_micros":2000,"ai_tokens_micros":25000,"total_micros":27000,"total_cents":3,"total_display":"$0.027000","currency":"USD"}}

$ psql ... -c "select type, quantity, cost_micros, idempotency_key from usage_events"
   type    | quantity | cost_micros | idempotency_key 
-----------+----------+-------------+-----------------
 api_call  |        1 |        2000 | order-42
 ai_tokens |     7000 |       25000 | order-42:tokens
(2 rows)
```

The second response carries `Idempotent-Replayed: true` and is byte-identical
to the first. The database has one `api_call` row and one `ai_tokens` row for
the one logical action, not two of each. The guarantee is the unique index
`usage_events (tenant_id, idempotency_key)` plus a per-tenant advisory lock in
the transaction; the 20-concurrent-retries test is what proves the race is
handled, not just the sequential case.

Also covered: same key reused with a *different* body is a `422
idempotency_key_reused` and records nothing (test 3).

## Quotas

**[x] Usage is checked against the tenant's plan; requests over the limit are rejected.**
**[x] Responses carry the correct status codes (429 / 402) and a message explaining why.**

Test: `PROBE 2 - Free tenant at the boundary: call 1,000 allowed, call 1,001 -> 402 upgrade_required with a clear message` (ok)
Test: `PROBE 2b - Pro tenant over its limit -> 429 quota_exceeded with Retry-After` (ok)
Test: `token quota: a single request that would cross the AI-token limit is rejected whole, and the call is not charged either` (ok)
Test: `past_due / canceled subscription -> 402 payment_required regardless of usage` (ok)

The documented boundary rule (DESIGN.md): allowed iff `used + requested <= limit`.
So with 999 used, call 1,000 succeeds and call 1,001 returns:

```
HTTP/1.1 402 Payment Required
{"error":"upgrade_required","message":"Free plan allows 1000 API calls per month; 1000 used, 1 requested. Upgrade to Pro for a higher limit.","type":"api_call","used":1000,"limit":1000,"requested":1,"remaining":0}
```

A Pro tenant over its limit gets `429 quota_exceeded` with `Retry-After` set
to the seconds until the next calendar month. A tenant whose Stripe
subscription is `past_due` or `canceled` gets `402 payment_required` before any
usage is looked at. Rejected requests write nothing (asserted via `GET /usage`
before/after).

## Cost calculation

**[x] Monthly usage rolls up into a cost figure per tenant.**
**[x] AI token pricing handles cached input tokens, reasoning tokens, and output pricing correctly.**
**[x] Pricing constants are pinned in config, with proof of correct totals.**

Test: `PROBE 5 - pinned pricing rules produce the exact expected totals` (ok)
Test: `PROBE 5b - GET /usage rollup matches the pinned constants exactly` (ok)

Pinned in `src/config.js` (micro-dollars per 1M tokens): input 2,500,000 ·
cached_input 625,000 · output 10,000,000 · reasoning 10,000,000; API call 2,000
micro-dollars each. Worked example, asserted in the test and visible in the
transcript above:

```
 1,000 input         @ $2.50 /M  =  2,500 micro$
 4,000 cached input  @ $0.625/M  =  2,500 micro$   (cheaper than fresh input)
   500 output        @ $10.00/M  =  5,000 micro$
 1,500 reasoning     @ $10.00/M  = 15,000 micro$   (billed as output)
                                  --------
                                   25,000 micro$ = $0.025   (+ $0.002 for the call = $0.027)
```

The test also asserts that pricing 7,000 tokens at any single rate gives a
*different* number (categories can't be summed first), that reasoning == output
rate, that rounding is per category and stays an integer, and that
`GET /usage` reports `total_micros: 56000` / `$0.056000` for three known calls.
All money is `BIGINT` micro-dollars in Postgres and integers in JS; no floats
anywhere on the money path.

## Stripe integration

**[x] Subscription checkout works end-to-end in Stripe test mode.**

`POST /billing/checkout` creates a `mode: subscription` Checkout Session with
the tenant id in `metadata` and `client_reference_id`. The end-to-end
click-through with a test card was run on my machine with the Stripe CLI
forwarding webhooks:

Run on my MacBook on 2026-10-11 with `docker compose up`, the Stripe CLI
forwarding to the app, and a real test-mode Checkout paid with card 4242 4242 4242 4242.

Before:

```
$ curl -s localhost:3000/usage -H "X-API-Key: $KEY"
{"tenant_id":"35b3434f-b6a1-484d-bfd9-5bc8989f5b17","period":"2026-10",...,"plan":{"id":"free","subscription_status":"none"},"api_calls":{"used":0,"limit":1000,"remaining":1000},"ai_tokens":{"used":0,"limit":100000,"remaining":100000},...}

$ curl -s -X POST localhost:3000/billing/checkout -H "X-API-Key: $KEY"
{"id":"cs_test_a1FBCVXB9KONmt0UIcXVCLISUALp2a4efwuFeepjALuWn8y1keI60SPmua","url":"https://checkout.stripe.com/c/pay/cs_test_a1FBCV..."}
```

Paid in the browser. Stripe's own record of the session (from `stripe events resend`):
`"status": "complete"`, `"payment_status": "paid"`, `"mode": "subscription"`,
`"customer": "cus_VQ9x5N2yKGfR4X"`, `"subscription": "sub_1UPJddDPaAkAJj20coM6rDFy"`,
`"metadata": {"plan_id": "pro", "tenant_id": "35b3434f-b6a1-484d-bfd9-5bc8989f5b17"}`.
(The test price I created in the dashboard happened to be AED 119/month rather than
USD 29; the app doesn't care what Stripe charges, it only mirrors the plan.)

`stripe listen` window (signing secret redacted):

```
> Ready! You are using Stripe API Version [2026-02-25.clover]. Your webhook signing secret is whsec_**** (^C to quit)
2026-10-11 14:08:53   --> checkout.session.completed [evt_1UPJdeDPaAkAJj20JdZjTcPM]
2026-10-11 14:08:53  <--  [200] POST http://localhost:3000/webhooks/stripe [evt_1UPJdeDPaAkAJj20JdZjTcPM]
2026-10-11 14:08:55   --> checkout.session.completed [evt_1UPJdeDPaAkAJj20JdZjTcPM]     <- replayed on purpose
2026-10-11 14:08:55  <--  [200] POST http://localhost:3000/webhooks/stripe [evt_1UPJdeDPaAkAJj20JdZjTcPM]
```

App log for those two deliveries - processed once, the replay recognised and ignored:

```
$ docker compose logs app | grep stripe_webhook | tail -2
app-1  | {"event":"stripe_webhook","id":"evt_1UPJdeDPaAkAJj20JdZjTcPM","type":"checkout.session.completed","status":"processed","detail":"tenant 35b3434f-b6a1-484d-bfd9-5bc8989f5b17 -> pro (active)"}
app-1  | {"event":"stripe_webhook","id":"evt_1UPJdeDPaAkAJj20JdZjTcPM","type":"checkout.session.completed","status":"duplicate"}
```

After:

```
$ curl -s localhost:3000/usage -H "X-API-Key: $KEY"
{"tenant_id":"35b3434f-b6a1-484d-bfd9-5bc8989f5b17","period":"2026-10",...,"plan":{"id":"pro","subscription_status":"active"},"api_calls":{"used":0,"limit":50000,"remaining":50000},"ai_tokens":{"used":0,"limit":5000000,"remaining":5000000},...}
```

One thing I got wrong the first time and want to record: my first `stripe listen`
was started without `--forward-to`, so events showed up in the CLI but never
reached the app and the tenant stayed on free. Restarting the listener with the
forward flag and replaying the stored event fixed it, which is also a nice
demonstration of why the event id, not the delivery, is what gets deduplicated.

**[x] Webhooks verify signatures, ignore duplicate events, and update tenant plan/status.**

Test: `PROBE 3 - checkout.session.completed flips the tenant Free -> Pro; GET /usage shows the new limits` (ok)
Test: `PROBE 4 - forged webhook (bad signature) -> 400, nothing changes` (ok)
Test: `PROBE 4b - replaying a real event twice -> processed once` (ok)
Test: `subscription lifecycle: updated(past_due) blocks with 402, deleted drops back to free` (ok)

Manual transcript against the running service (events signed locally with the
webhook secret using `stripe.webhooks.generateTestHeaderString`, so this is the
same verification path Stripe's real deliveries go through):

```
valid    -> 200 {"received":true,"id":"evt_test_1791703832395","status":"processed","detail":"tenant 10a4c0fc-... -> pro (active)"}
replay   -> 200 {"received":true,"id":"evt_test_1791703832395","status":"duplicate"}
tampered -> 400 {"error":"invalid_signature","message":"No signatures found matching the expected signature for payload. ..."}
forged   -> 400 {"error":"invalid_signature","message":"No signatures found matching the expected signature for payload. ..."}

# tenants row before / after the valid event
Acme (free)|free|none|
Acme (free)|pro|active|cus_test_1
# GET /usage after:  {"plan":{"id":"pro","subscription_status":"active"},"api_limit":50000,"tok_limit":5000000}
```

The webhook route is mounted with `express.raw()` *before* the JSON parser so
the signature is checked against the exact bytes. Dedupe is the primary key on
`stripe_events(id)`: the insert for a replay conflicts and the handler returns
`duplicate` with 200 (so Stripe stops retrying) without touching anything.
Forged events are rejected before they are even recorded.

## Data model, tests & documentation

**[x] Database includes tenants, plans, subscriptions, and usage events; customer data isolated per tenant.**

`migrations/001_initial.sql` - tables `plans`, `tenants`, `subscriptions`,
`usage_events`, `stripe_events`, `jobs`, `usage_alerts`. Every customer-data
table has `tenant_id`; every service query filters on it; there is no
list-all-usage route.

Test: `tenants are isolated: no key -> 401, another tenant's usage is invisible` (ok)

**[x] README + architecture diagram + setup instructions; the required files present.**

`README.md` (diagram in ASCII), `DESIGN.md`, `capstone.yaml`, `EVIDENCE.md`,
`BUILDLOG.md`, `.env.example`.

## Shared requirements (every capstone)

| # | Requirement | Where |
|---|---|---|
| 1 | Layered architecture | `routes/` (HTTP) → `services/` (logic) → `db/` (SQL); `jobs/` separate |
| 2 | Validation at the boundary | zod on every body; test `validation at the boundary: bad input is a clean 400, never a 500, and never metered` (ok) |
| 3 | ≥1 background job with retries + failure alert | `jobs/worker.js` + `usageAlerts.js`; tests 17-20: enqueue off the request path, 80%/100% alerts once each, delivery failure retried with backoff until `max_attempts` then `status=failed` + an `"event":"ALERT"` log line |
| 4 | Real persistence: migrations, indexes, isolated tenants | `migrations/`, unique idempotency index, rollup index `(tenant_id, period, type)`, `jobs (status, run_at)` |
| 5 | Idempotency where it matters | Probe 1 / 1b above; Stripe event dedupe (Probe 4b) |
| 6 | Secrets clean | `.env` git-ignored, `.env.example` committed; API keys stored as sha256 only and shown once; a `sk_live_` key makes the app refuse to start |
| 7 | Cost tracked | every `usage_events` row carries `cost_micros`; `GET /usage` rolls it up; no AI is actually called |
