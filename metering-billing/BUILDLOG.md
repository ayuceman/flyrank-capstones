# BUILDLOG

The brief asks for an honest log of where AI helped, where it was wrong, and
what I changed. Here it is.

## How this was built

I used an AI assistant (Claude, in Anthropic's Cowork tool) as a pair
programmer for the whole capstone, working from the brief and from a design
I agreed with it first. The split, honestly:

- **Me:** chose this capstone, chose the stack (same Express + Postgres +
  Docker setup I used in the track assignments), agreed the design in
  `DESIGN.md` before any code (the data model, the idempotency strategy, the
  402-vs-429 rule, the plan numbers, integer micro-dollars), reviewed every
  file, ran everything on my own machine, did the Stripe test-mode checkout
  with the Stripe CLI, and wrote the evidence from my own runs.
- **AI:** drafted most of the code and the tests from that design, wrote the
  first versions of the README and this file, and debugged the test failures
  described below.

I can explain any part of this codebase. The parts I'd point an interviewer
at first are `src/services/metering.js` (the transaction with the advisory
lock, the unique-violation catch) and `src/services/pricing.js` (why each
token category is rounded separately).

## Where the AI was wrong, and what changed

1. **Replayed responses were not byte-identical to the original.** The first
   draft returned the freshly built object on the first call and the stored
   `jsonb` on replays. Postgres normalises `jsonb` key order, so the two
   serialised differently and the 20-concurrent-retries test caught it. Fix:
   the first call now also returns the row it just stored, so every response
   for a key is the same bytes. Small, but it's exactly the kind of thing a
   "mirrors the first" probe is there to catch.

2. **A Stripe customer id already attached to another tenant crashed the
   webhook handler with a 500** (unique constraint on
   `tenants.stripe_customer_id`). Surfaced by re-running the test suite on a
   reused database. Fix: the handler checks ownership first, keeps the plan
   change, leaves the customer id alone, and logs a `stripe_customer_conflict`
   line. The test ids were also made unique per run.

3. **The usage-alert job's failure path lost alerts.** First draft inserted the
   `usage_alerts` row and then tried to POST the alert; if the POST failed and
   the job retried, the row already existed so nothing was re-sent. Fix: on
   delivery failure the row is deleted before the job throws, so the retry
   re-sends. A real outbox pattern would be cleaner; this is noted in the
   README limitations.

4. **First `npm test` script was wrong** (`node --test test/` instead of a
   file glob). Trivial, but it's in the history.

## What I decided that the brief left open

- Plan limits for Pro: 50,000 calls and 5M tokens at $29/month.
- Boundary rule: `used + requested <= limit` is allowed. The 1,000th Free call
  succeeds; the 1,001st does not.
- 402 for Free-at-limit (there is a plan that would allow it) and for
  past_due/canceled; 429 for Pro-at-limit (nothing to buy, wait for the reset).
- A request's API call and its tokens are checked together and either both
  land or neither does. A rejected request is not charged a call.
- One logical action = two `usage_events` rows (one per type). The replay
  lookup keys off the `api_call` row.
- Money is integer micro-dollars; prices are integer micro-dollars per million
  tokens; rounding happens once per category.

## What I would not claim

- I did not load-test this. The per-tenant advisory lock serialises a tenant's
  writes, which is correct but means one very chatty tenant can't be
  parallelised. Fine for this scope.
- The background worker runs inside the API process. That's a deployment
  simplification, not an architecture claim.
