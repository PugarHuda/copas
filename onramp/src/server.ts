import { serve } from '@hono/node-server';
import { createApp } from './app.js';

try {
  process.loadEnvFile(); // .env if present
} catch {}
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp().fetch, port }, (i) => console.log(`@copas/onramp listening on :${i.port}`));
