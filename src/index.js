import { createApp } from "./app.js";
import { migrate } from "./db/migrate.js";

const PORT = process.env.PORT || 3000;

await migrate();
createApp().listen(PORT, () => console.log(`metering service on http://localhost:${PORT}`));
