// Tiny forward-only migration runner: applies migrations/*.sql in filename order,
// records each in schema_migrations, skips the ones already applied.
import fs from "node:fs";
import path from "node:path";
import { pool } from "./pool.js";

const DIR = path.resolve(import.meta.dirname, "..", "..", "migrations");

export async function migrate({ log = console.log } = {}) {
  await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())");
  const applied = new Set((await pool.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(DIR, f), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      await client.query("COMMIT");
      log(`migrated ${f}`);
    } catch (e) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${f} failed: ${e.message}`);
    } finally {
      client.release();
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith("migrate.js")) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e.message); process.exit(1); });
}
