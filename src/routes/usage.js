import express from "express";
import { requireTenant } from "./auth.js";
import { usageReport } from "../services/usage.js";

const router = express.Router();

// GET /usage - this month's rollup for the calling tenant
router.get("/", requireTenant, async (req, res, next) => {
  try {
    const period = typeof req.query.period === "string" && /^\d{4}-\d{2}$/.test(req.query.period) ? req.query.period : undefined;
    res.json(await usageReport(req.tenant, period));
  } catch (e) { next(e); }
});

export default router;
