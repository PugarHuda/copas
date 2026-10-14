// Vercel entry: every path is rewritten here (vercel.json) and served by the same Hono app as src/server.ts.
import { createApp } from "../dist/app.js";

const app = createApp();
const A = "0x[0-9a-fA-F]{40}";
// [path, CDN seconds, stale-while-revalidate seconds]. Only successful GETs are cached; errors pass through uncached.
//  - Nansen calls are paid per call (x402, Monad USDC): 1 day, served stale up to a week while revalidating. The analysis sets its own Cache-Control in src/app.ts
//    (1 day + 7 days stale for a real LLM answer, no-store for the no-LLM fallback), which wins here.
//  - stats / attest read live fills and positions: 5 min.
//  - /mcp (POST, JSON-RPC) matches no rule and answers Cache-Control: no-store, so it is never CDN-cached.
const CACHE = [
  [new RegExp(`^/(discover|leader/${A}/alignment)$`), 86400, 604800],
  [new RegExp(`^/(leader/${A}/stats|attest/${A})$`), 300, 600],
];

async function handle(req) {
  const res = await app.fetch(req);
  const path = new URL(req.url).pathname;
  const own = res.headers.get("cache-control");
  if (own) {
    if (!own.startsWith("public")) return res;
    const out = new Response(res.body, res);
    out.headers.set("vercel-cdn-cache-control", own.replace(/^public, s-maxage=/, "max-age="));
    return out;
  }
  const rule = req.method === "GET" && res.ok && CACHE.find(([re]) => re.test(path));
  if (!rule) return res;
  const [, ttl, swr] = rule;
  const out = new Response(res.body, res);
  out.headers.set("cache-control", `public, s-maxage=${ttl}, stale-while-revalidate=${swr}`);
  out.headers.set("vercel-cdn-cache-control", `max-age=${ttl}, stale-while-revalidate=${swr}`);
  return out;
}
export { handle as GET, handle as POST, handle as OPTIONS, handle as DELETE };
