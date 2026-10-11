import { createApp } from "./app.js";
import { migrate } from "./db/migrate.js";
import { startWorker } from "./jobs/worker.js";
import { pool } from "./db/pool.js";

const PORT = process.env.PORT || 3000;

await migrate();
const server = createApp().listen(PORT, () => console.log(`metering service on http://localhost:${PORT}`));

let worker = null;
if (process.env.JOBS_ENABLED !== "false") worker = startWorker();

const shutdown = async () => {
  console.log("shutting down");
  worker?.stop();
  server.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
