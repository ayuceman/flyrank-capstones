// Demo data: two tenants, one on each plan. Prints their API keys (only time you see them).
import { migrate } from "../src/db/migrate.js";
import { pool } from "../src/db/pool.js";
import { createTenant } from "../src/services/tenants.js";

await migrate({ log: () => {} });
const existing = await pool.query("SELECT count(*)::int AS n FROM tenants");
if (existing.rows[0].n > 0 && !process.argv.includes("--force")) {
  console.log(`tenants already exist (${existing.rows[0].n}); pass --force to add two more`);
} else {
  const a = await createTenant({ name: "Acme (free)", plan_id: "free" });
  const b = await createTenant({ name: "Globex (pro)", plan_id: "pro" });
  await pool.query("UPDATE tenants SET subscription_status = 'active' WHERE id = $1", [b.id]);
  console.log("seeded two tenants. API keys are shown ONCE, save them:\n");
  for (const t of [a, b]) console.log(`  ${t.name.padEnd(14)} id=${t.id}\n  ${" ".repeat(14)} X-API-Key: ${t.api_key}\n`);
}
await pool.end();
