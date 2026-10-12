// Vercel entry: every path is rewritten here (vercel.json) and served by the same Hono app as src/server.ts.
import { createApp } from "../dist/app.js";

const app = createApp();
// Nansen calls spend paid credits: let the CDN serve repeats for an hour.
const CACHED = /^\/(discover|leader\/0x[0-9a-fA-F]{40}\/alignment)$/;

async function handle(req) {
  const res = await app.fetch(req);
  if (req.method !== "GET" || !res.ok || !CACHED.test(new URL(req.url).pathname)) return res;
  const out = new Response(res.body, res);
  out.headers.set("cache-control", "public, s-maxage=3600, stale-while-revalidate=86400");
  out.headers.set("vercel-cdn-cache-control", "max-age=3600");
  return out;
}
export { handle as GET, handle as POST, handle as OPTIONS };
