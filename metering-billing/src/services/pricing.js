// Pure money math. No I/O, no floats, every input and output an integer.
import { PRICING } from "../config.js";

// micro-dollars for n tokens at a per-million price, rounded half up at the end
function tokenCost(n, perMillionMicros) {
  if (!Number.isInteger(n) || n < 0) throw new TypeError(`token count must be a non-negative integer, got ${n}`);
  // n * perMillion can reach ~1e13 for 1M tokens at $10 - safely inside 2^53
  return Math.round((n * perMillionMicros) / 1_000_000);
}

// Breakdown = { input, cached_input, output, reasoning } token counts.
// Rules: cached input is billed at its own (cheaper) rate; reasoning tokens are
// billed at the output rate; each category is priced separately and THEN summed.
// Adding the counts first and multiplying by one price would be wrong.
export function priceTokens(breakdown) {
  const b = normalizeBreakdown(breakdown);
  const p = PRICING.tokens_per_million_micros;
  const lines = {
    input: tokenCost(b.input, p.input),
    cached_input: tokenCost(b.cached_input, p.cached_input),
    output: tokenCost(b.output, p.output),
    reasoning: tokenCost(b.reasoning, p.reasoning),
  };
  const total_micros = lines.input + lines.cached_input + lines.output + lines.reasoning;
  return { lines, total_micros, total_tokens: b.input + b.cached_input + b.output + b.reasoning };
}

export function priceApiCalls(n) {
  if (!Number.isInteger(n) || n < 0) throw new TypeError("call count must be a non-negative integer");
  return n * PRICING.api_call_micros;
}

export function normalizeBreakdown(b = {}) {
  const out = { input: 0, cached_input: 0, output: 0, reasoning: 0 };
  for (const k of Object.keys(out)) {
    const v = b[k] ?? 0;
    if (!Number.isInteger(v) || v < 0) throw new TypeError(`${k} must be a non-negative integer`);
    out[k] = v;
  }
  return out;
}

// for display: micro-dollars -> "$1.234567" style string without going through floats
export function formatMicros(micros) {
  const sign = micros < 0 ? "-" : "";
  const abs = Math.abs(micros);
  const dollars = Math.floor(abs / 1_000_000);
  const frac = String(abs % 1_000_000).padStart(6, "0");
  return `${sign}$${dollars}.${frac}`;
}

export const microsToCents = (micros) => Math.round(micros / 10_000);
