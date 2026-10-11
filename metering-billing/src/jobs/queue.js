// Minimal job queue on a Postgres table. enqueue() inside a transaction means
// the job exists iff the usage event does.
export async function enqueue(client, type, payload = {}, { runAt = new Date(), maxAttempts = 5 } = {}) {
  const { rows } = await client.query(
    "INSERT INTO jobs (type, payload, run_at, max_attempts) VALUES ($1, $2, $3, $4) RETURNING id",
    [type, payload, runAt, maxAttempts]
  );
  return rows[0].id;
}
