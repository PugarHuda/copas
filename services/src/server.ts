import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

try {
  process.loadEnvFile(".env");
} catch {
  // no .env: rely on the real environment
}
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp().fetch, port }, () => console.log(`@copas/services on http://localhost:${port}`));
