import express from "express";
import { z } from "zod";
import { requireTenant } from "./auth.js";
import { record } from "../services/metering.js";

const router = express.Router();

const nonneg = z.number().int().min(0).max(50_000_000);
const Body = z.object({
  prompt: z.string().min(1).max(4000),
  // simulated token counts, i.e. what a real model call would have reported back
  tokens: z.object({
    input: nonneg.optional(),
    cached_input: nonneg.optional(),
    output: nonneg.optional(),
    reasoning: nonneg.optional(),
  }).strict().optional(),
}).strict();

// POST /generate - the one dummy billable action.
// Headers: X-API-Key, Idempotency-Key (required).
router.post("/", requireTenant, async (req, res, next) => {
  const key = req.get("idempotency-key");
  if (!key || key.length > 200) {
    return res.status(400).json({ error: "idempotency_key_required", message: "Send an Idempotency-Key header (1-200 chars) so a retry can't be charged twice." });
  }
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_input", issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) });
  }

  try {
    const result = await record({
      tenant: req.tenant,
      idempotencyKey: key,
      request: parsed.data,
      buildResponse: ({ usage }) => ({
        id: `gen_${key}`,
        // pretend output. a real service would put the model's answer here.
        output: `Generated ${usage.ai_tokens.output} output tokens for: ${parsed.data.prompt.slice(0, 40)}`,
        usage,
      }),
    });
    res.set("Idempotent-Replayed", String(result.replayed));
    if (result.body?.retry_after_seconds) res.set("Retry-After", String(result.body.retry_after_seconds));
    res.status(result.status).json(result.body);
  } catch (e) { next(e); }
});

export default router;
