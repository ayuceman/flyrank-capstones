import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { start, stop, closePool, freshTenant, generate, pool } from "./helpers.js";
import { drain } from "../src/jobs/worker.js";
import { enqueue } from "../src/jobs/queue.js";

before(start);
after(async () => { await stop(); await closePool(); });

const quiet = { log: () => {} };

test("a usage event enqueues a job; the request does not wait for it", async () => {
  const t = await freshTenant("job");
  const t0 = Date.now();
  await generate(t.api_key, "j1", { output: 10 });
  assert.ok(Date.now() - t0 < 2000);
  const pending = (await pool.query("SELECT count(*)::int AS n FROM jobs WHERE status='pending' AND payload->>'tenant_id' = $1", [t.id])).rows[0].n;
  assert.equal(pending, 1);
});

test("usage alerts fire once at 80% and once at 100%, never twice", async () => {
  const t = await freshTenant("alerts");
  // 85,000 of 100,000 tokens -> crosses 80%
  await generate(t.api_key, "a", { output: 85_000 });
  await drain(quiet);
  let alerts = (await pool.query("SELECT type, threshold FROM usage_alerts WHERE tenant_id=$1 ORDER BY threshold", [t.id])).rows;
  assert.deepEqual(alerts, [{ type: "ai_tokens", threshold: 80 }]);

  // another event at 90%: still over 80%, must not re-alert
  await generate(t.api_key, "b", { output: 5_000 });
  await drain(quiet);
  alerts = (await pool.query("SELECT type, threshold FROM usage_alerts WHERE tenant_id=$1 ORDER BY threshold", [t.id])).rows;
  assert.equal(alerts.length, 1);

  // to exactly 100%
  await generate(t.api_key, "c", { output: 10_000 });
  await drain(quiet);
  alerts = (await pool.query("SELECT type, threshold FROM usage_alerts WHERE tenant_id=$1 ORDER BY threshold", [t.id])).rows;
  assert.deepEqual(alerts, [{ type: "ai_tokens", threshold: 80 }, { type: "ai_tokens", threshold: 100 }]);

  const jobs = (await pool.query("SELECT status, attempts FROM jobs WHERE payload->>'tenant_id' = $1", [t.id])).rows;
  assert.ok(jobs.every((j) => j.status === "done" && j.attempts === 1));
});

test("delivery failure retries with backoff, then marks the job failed and raises an ALERT", async () => {
  // a webhook receiver that always 500s
  let hits = 0;
  const srv = http.createServer((req, res) => { hits++; res.writeHead(500); res.end(); });
  await new Promise((r) => srv.listen(0, r));
  process.env.ALERT_WEBHOOK_URL = `http://localhost:${srv.address().port}/hook`;

  const t = await freshTenant("retry");
  await generate(t.api_key, "a", { output: 100_000 }); // 100% straight away
  // drain repeatedly, fast-forwarding run_at so we don't wait for real backoff
  const errors = [];
  const origError = console.error;
  console.error = (m) => errors.push(String(m));
  try {
    for (let i = 0; i < 10; i++) {
      await pool.query("UPDATE jobs SET run_at = now() WHERE status = 'pending'");
      await drain(quiet);
    }
  } finally {
    console.error = origError;
    delete process.env.ALERT_WEBHOOK_URL;
    srv.close();
  }
  const job = (await pool.query("SELECT status, attempts, max_attempts, last_error FROM jobs WHERE payload->>'tenant_id' = $1", [t.id])).rows[0];
  assert.equal(job.status, "failed");
  assert.equal(job.attempts, job.max_attempts);
  assert.match(job.last_error, /HTTP 500/);
  assert.equal(hits, job.max_attempts, "one delivery attempt per job attempt");
  assert.ok(errors.some((e) => e.includes('"event":"ALERT"')), "a failure alert was emitted");
  // the alert row was rolled back so a later fix would re-send it
  const rows = (await pool.query("SELECT count(*)::int AS n FROM usage_alerts WHERE tenant_id=$1", [t.id])).rows[0].n;
  assert.equal(rows, 0);
});

test("unknown job types fail cleanly without taking the worker down", async () => {
  const client = await pool.connect();
  try { await enqueue(client, "does_not_exist", {}, { maxAttempts: 1 }); } finally { client.release(); }
  const origError = console.error; console.error = () => {};
  try { await drain(quiet); } finally { console.error = origError; }
  const job = (await pool.query("SELECT status, last_error FROM jobs WHERE type = 'does_not_exist' ORDER BY created_at DESC LIMIT 1")).rows[0];
  assert.equal(job.status, "failed");
  assert.match(job.last_error, /no handler/);
});
