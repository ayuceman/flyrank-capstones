#!/usr/bin/env bash
# End-to-end smoke test against a running stack (docker compose up).
#   bash scripts/smoke.sh
# Creates its own tenant, so it never touches the seeded ones.
set -u
BASE="${BASE:-http://localhost:3000}"
ADMIN="${ADMIN_KEY:-change-me-admin-key}"
JSON='Content-Type: application/json'
pass=0; fail=0
ok()   { pass=$((pass+1)); printf "  \033[32mok\033[0m   %s\n" "$1"; }
bad()  { fail=$((fail+1)); printf "  \033[31mFAIL\033[0m %s\n" "$1"; }
head1(){ printf "\n\033[1m%s\033[0m\n" "$1"; }
status(){ curl -s -o /dev/null -w "%{http_code}" "$@"; }

head1 "0. Service"
curl -sf "$BASE/health" >/dev/null && ok "GET /health reachable at $BASE" || { bad "cannot reach $BASE - is 'docker compose up' running?"; exit 1; }

head1 "1. Create a tenant"
RESP=$(curl -s -X POST "$BASE/tenants" -H "X-Admin-Key: $ADMIN" -H "$JSON" -d '{"name":"Smoke Test Co"}')
KEY=$(printf '%s' "$RESP" | sed -E 's/.*"api_key":"([^"]+)".*/\1/')
case "$KEY" in mk_*) ok "tenant created, key starts with mk_";; *) bad "could not create tenant: $RESP"; exit 1;; esac
curl -s "$BASE/usage" -H "X-API-Key: $KEY" | grep -q '"plan":{"id":"free"' && ok "GET /usage shows plan free, 0 used" || bad "unexpected /usage"

head1 "2. Probe 1 - idempotency"
BODY='{"prompt":"Summarise this ticket","tokens":{"input":1000,"cached_input":4000,"output":500,"reasoning":1500}}'
R1=$(curl -s -D /tmp/h1 -X POST "$BASE/generate" -H "X-API-Key: $KEY" -H "Idempotency-Key: order-42" -H "$JSON" -d "$BODY")
R2=$(curl -s -D /tmp/h2 -X POST "$BASE/generate" -H "X-API-Key: $KEY" -H "Idempotency-Key: order-42" -H "$JSON" -d "$BODY")
grep -qi "idempotent-replayed: false" /tmp/h1 && ok "first call: Idempotent-Replayed: false" || bad "first call header"
grep -qi "idempotent-replayed: true"  /tmp/h2 && ok "retry:      Idempotent-Replayed: true"  || bad "retry header"
[ "$R1" = "$R2" ] && ok "retry body is byte-identical to the first" || bad "bodies differ"
curl -s "$BASE/usage" -H "X-API-Key: $KEY" | grep -q '"api_calls":{"used":1,' && ok "only ONE api call metered after two requests" || bad "double counted"
S=$(status -X POST "$BASE/generate" -H "X-API-Key: $KEY" -H "Idempotency-Key: order-42" -H "$JSON" -d '{"prompt":"different"}')
[ "$S" = "422" ] && ok "same key + different body -> 422" || bad "expected 422, got $S"
echo "  first response: $R1"

head1 "3. Probe 5 - pricing"
echo "$R1" | grep -q '"cost_micros":25000' && ok "tokens priced at 25,000 micro\$ (2500 + 2500 + 5000 + 15000)" || bad "token price"
echo "$R1" | grep -q '"total_cost_micros":27000' && ok "plus 2,000 for the call = 27,000 micro\$" || bad "total price"
curl -s "$BASE/usage" -H "X-API-Key: $KEY" | grep -q '"total_display":"\$0.027000"' && ok 'GET /usage shows $0.027000' || bad "usage cost"

head1 "4. Validation"
S=$(status -X POST "$BASE/generate" -H "X-API-Key: $KEY" -H "$JSON" -d '{"prompt":"x"}');                                  [ "$S" = "400" ] && ok "no Idempotency-Key -> 400" || bad "got $S"
S=$(status -X POST "$BASE/generate" -H "X-API-Key: $KEY" -H "Idempotency-Key: v1" -H "$JSON" -d '{"prompt":"x","tokens":{"output":-5}}'); [ "$S" = "400" ] && ok "negative tokens -> 400" || bad "got $S"
S=$(status -X POST "$BASE/generate" -H "X-API-Key: $KEY" -H "Idempotency-Key: v2" -H "$JSON" -d '{not json');               [ "$S" = "400" ] && ok "bad JSON -> 400" || bad "got $S"
S=$(status "$BASE/usage");                                                                                                  [ "$S" = "401" ] && ok "no API key -> 401" || bad "got $S"

head1 "5. Probe 2 - quota boundary (sending 999 calls, ~10-20s)"
i=1; while [ $i -le 999 ]; do curl -s -o /dev/null -X POST "$BASE/generate" -H "X-API-Key: $KEY" -H "Idempotency-Key: fill-$i" -H "$JSON" -d '{"prompt":"x"}'; i=$((i+1)); done
U=$(curl -s "$BASE/usage" -H "X-API-Key: $KEY")
echo "$U" | grep -q '"api_calls":{"used":1000,"limit":1000,"remaining":0}' && ok "1,000 of 1,000 used (the 1,000th call was allowed)" || bad "usage: $U"
R=$(curl -s -w '\n%{http_code}' -X POST "$BASE/generate" -H "X-API-Key: $KEY" -H "Idempotency-Key: one-too-many" -H "$JSON" -d '{"prompt":"x"}')
S=$(echo "$R" | tail -1); B=$(echo "$R" | sed '$d')
[ "$S" = "402" ] && echo "$B" | grep -q upgrade_required && ok "call 1,001 -> 402 upgrade_required" || bad "got $S $B"
echo "  $B"
curl -s "$BASE/usage" -H "X-API-Key: $KEY" | grep -q '"used":1000,' && ok "rejected call recorded nothing" || bad "rejected call was metered"

head1 "6. Probe 4 - forged webhook"
S=$(status -X POST "$BASE/webhooks/stripe" -H "$JSON" -H "stripe-signature: t=1,v1=deadbeef" -d '{"id":"evt_fake","type":"checkout.session.completed","data":{"object":{}}}')
[ "$S" = "400" ] && ok "bad signature -> 400" || bad "got $S"
S=$(status -X POST "$BASE/webhooks/stripe" -H "$JSON" -d '{}');  [ "$S" = "400" ] && ok "missing signature -> 400" || bad "got $S"

head1 "Result: $pass passed, $fail failed"
echo "Probe 3 (real Stripe Checkout) needs your Stripe test key + 'stripe listen' - see README."
[ $fail -eq 0 ]
