// Background worker: polls the jobs table, runs one job at a time, retries with
// backoff, and raises a loud alert when a job runs out of attempts.
// Runs in the API process when JOBS_ENABLED=true. The request path only ever
// inserts a row; it never waits for this.
import { pool } from "../db/pool.js";
import { checkUsageAlerts } from "./usageAlerts.js";

const HANDLERS = { check_usage_alerts: checkUsageAlerts };

const backoffMs = (attempt) => Math.min(60_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);

// claim one due job with SKIP LOCKED so several workers never grab the same row
async function claim() {
  const { rows } = await pool.query(`
    UPDATE jobs SET status = 'running', attempts = attempts + 1
     WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND run_at <= now()
                  ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED)
     RETURNING *`);
  return rows[0] || null;
}

export async function runOne({ log = console.log } = {}) {
  const job = await claim();
  if (!job) return null;
  const handler = HANDLERS[job.type];
  try {
    if (!handler) throw new Error(`no handler for job type ${job.type}`);
    const detail = await handler(job.payload, { log });
    await pool.query("UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL WHERE id = $1", [job.id]);
    log(JSON.stringify({ event: "job_done", id: job.id, type: job.type, attempt: job.attempts, detail }));
    return { id: job.id, status: "done" };
  } catch (e) {
    if (job.attempts < job.max_attempts) {
      const delay = backoffMs(job.attempts);
      await pool.query("UPDATE jobs SET status = 'pending', run_at = now() + ($2 || ' milliseconds')::interval, last_error = $3 WHERE id = $1", [job.id, String(delay), e.message]);
      log(JSON.stringify({ event: "job_retry", id: job.id, type: job.type, attempt: job.attempts, next_in_ms: delay, error: e.message }));
      return { id: job.id, status: "retry" };
    }
    await pool.query("UPDATE jobs SET status = 'failed', finished_at = now(), last_error = $2 WHERE id = $1", [job.id, e.message]);
    // the failure alert. in a real deployment this line is what a log-based alert triggers on.
    console.error(JSON.stringify({ event: "ALERT", severity: "error", message: "job failed permanently", id: job.id, type: job.type, attempts: job.attempts, error: e.message }));
    return { id: job.id, status: "failed" };
  }
}

// drain everything that is due right now (used by tests and by `node src/jobs/worker.js --once`)
export async function drain(opts) {
  const results = [];
  for (;;) {
    const r = await runOne(opts);
    if (!r) break;
    results.push(r);
  }
  return results;
}

export function startWorker({ intervalMs = 1000, log = console.log } = {}) {
  let stopped = false;
  (async () => {
    log("jobs worker started");
    while (!stopped) {
      try {
        const r = await runOne({ log });
        if (!r) await new Promise((res) => setTimeout(res, intervalMs));
      } catch (e) {
        console.error("worker loop error:", e.message);
        await new Promise((res) => setTimeout(res, intervalMs));
      }
    }
  })();
  return { stop: () => { stopped = true; } };
}

if (process.argv[1] && process.argv[1].endsWith("worker.js")) {
  if (process.argv.includes("--once")) {
    drain().then((r) => { console.log(`ran ${r.length} job(s)`); return pool.end(); });
  } else {
    startWorker();
  }
}
