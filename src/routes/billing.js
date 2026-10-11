import express from "express";
import { requireTenant } from "./auth.js";
import { createCheckoutSession } from "../services/billing.js";

const router = express.Router();

// POST /billing/checkout - start a Stripe Checkout for the Pro plan
router.post("/checkout", requireTenant, async (req, res, next) => {
  try {
    const out = await createCheckoutSession(req.tenant);
    if (out.error) return res.status(out.error.status).json({ error: out.error.code, message: out.error.message });
    res.status(201).json(out.session);
  } catch (e) {
    if (e?.type?.startsWith?.("Stripe")) {
      return res.status(502).json({ error: "stripe_error", message: e.message });
    }
    next(e);
  }
});

router.get("/success", (req, res) => res.json({ message: "Checkout complete. Your plan updates as soon as Stripe's webhook arrives (usually within a second). Check GET /usage." }));
router.get("/cancel", (req, res) => res.json({ message: "Checkout cancelled. Nothing changed." }));

export default router;
