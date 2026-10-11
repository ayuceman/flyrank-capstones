import express from "express";
import { pool } from "./db/pool.js";

export function createApp() {
  const app = express();

  app.get("/health", async (req, res) => {
    try {
      await pool.query("SELECT 1");
      res.json({ status: "ok", database: "ok" });
    } catch (e) {
      res.status(503).json({ status: "degraded", database: e.message });
    }
  });

  app.get("/plans", async (req, res, next) => {
    try {
      const { rows } = await pool.query("SELECT id, name, api_calls_limit, ai_tokens_limit, price_cents FROM plans ORDER BY price_cents");
      res.json(rows);
    } catch (e) { next(e); }
  });

  app.use((req, res) => res.status(404).json({ error: "not_found" }));
  app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json" });
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  });
  return app;
}
