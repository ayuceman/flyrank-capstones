import express from "express";
import { verifyWebhook, handleWebhookEvent } from "../services/billing.js";

const router = express.Router();

// POST /webhooks/stripe
// Mounted with express.raw() so the signature is checked against the exact
// bytes Stripe sent. A JSON-parsed-then-reserialized body would never verify.
router.post("/stripe", express.raw({ type: "application/json" }), async (req, res, next) => {
  const sig = req.get("stripe-signature");
  if (!sig) return res.status(400).json({ error: "missing_signature" });

  let event;
  try {
    event = verifyWebhook(req.body, sig);
  } catch (e) {
    // forged, tampered, or signed with a different secret: 400, nothing changes
    return res.status(400).json({ error: "invalid_signature", message: e.message });
  }

  try {
    const result = await handleWebhookEvent(event);
    console.log(JSON.stringify({ event: "stripe_webhook", id: event.id, type: event.type, ...result }));
    // always 200 for a verified event, including duplicates, so Stripe stops retrying
    res.json({ received: true, id: event.id, ...result });
  } catch (e) { next(e); }
});

export default router;
