// Everything that is a number somebody might argue about lives here, pinned.
// Money: integer micro-dollars (1 USD = 1_000_000). Token prices: micro-dollars per 1M tokens.

export const PRICING = {
  // $0.002 per API call
  api_call_micros: 2_000,

  // per 1,000,000 tokens, in micro-dollars  ($2.50 / $0.625 / $10.00 per 1M)
  tokens_per_million_micros: {
    input: 2_500_000,
    cached_input: 625_000,   // 25% of input: the provider already had it
    output: 10_000_000,
    reasoning: 10_000_000,   // hidden thinking tokens are billed as output tokens
  },
};

export const PLAN_QUOTAS = {
  free: { api_calls: 1_000, ai_tokens: 100_000 },
  pro: { api_calls: 50_000, ai_tokens: 5_000_000 },
};

export const ALERT_THRESHOLDS = [80, 100];

export function periodOf(date = new Date()) {
  return date.toISOString().slice(0, 7); // 'YYYY-MM' in UTC
}

export function secondsUntilNextPeriod(now = new Date()) {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return Math.max(1, Math.ceil((next - now) / 1000));
}
