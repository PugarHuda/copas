// Vercel entry: every path is rewritten here (vercel.json) and served by the same Hono app as src/server.ts.
import { createApp } from "../dist/app.js";

const app = createApp();
const A = "0x[0-9a-fA-F]{40}";
// [path, CDN seconds, stale-while-revalidate seconds]. Only successful GETs are cached; errors pass through uncached.
//  - Nansen calls spend paid credits, the analysis is a ~20 s LLM call: 1 h.
//  - stats / attest read live fills and positions: 5 min.
const CACHE = [
  [new RegExp(`^/(discover|leader/${A}/alignment)$`), 3600, 86400],
  [new RegExp(`^/leader/${A}/analysis$`), 3600, 86400],
  [new RegExp(`^/(leader/${A}/stats|attest/${A})$`), 300, 600],
];

async function handle(req) {
  const res = await app.fetch(req);
  const path = new URL(req.url).pathname;
  const rule = req.method === "GET" && res.ok && CACHE.find(([re]) => re.test(path));
  if (!rule) return res;
  const [, ttl, swr] = rule;
  const out = new Response(res.body, res);
  out.headers.set("cache-control", `public, s-maxage=${ttl}, stale-while-revalidate=${swr}`);
  out.headers.set("vercel-cdn-cache-control", `max-age=${ttl}, stale-while-revalidate=${swr}`);
  return out;
}
export { handle as GET, handle as POST, handle as OPTIONS };
