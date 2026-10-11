import express from "express";
import { z } from "zod";
import { requireAdmin } from "./auth.js";
import { createTenant } from "../services/tenants.js";

const router = express.Router();
const Body = z.object({ name: z.string().min(1).max(100), plan_id: z.enum(["free", "pro"]).optional() }).strict();

// POST /tenants - admin only. Returns the API key once.
router.post("/", requireAdmin, async (req, res, next) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_input", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  try {
    res.status(201).json(await createTenant(parsed.data));
  } catch (e) { next(e); }
});

export default router;
