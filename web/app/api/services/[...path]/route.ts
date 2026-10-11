import { NextResponse } from "next/server";

/**
 * Proxy to @copas/services (copas/services, Hono on :8787). Keeps API keys server-side
 * and gives the browser one origin. Only the routes the UI uses are allowed.
 */
const BASE = process.env.COPAS_SERVICES_URL || "http://localhost:8787";
const ALLOW: [string, RegExp][] = [
  ["GET", /^leader\/0x[0-9a-fA-F]{40}\/(stats|analysis|alignment)$/],
  ["POST", /^leader\/0x[0-9a-fA-F]{40}\/backtest$/],
  ["GET", /^attest\/0x[0-9a-fA-F]{40}$/],
  ["GET", /^discover$/],
  ["POST", /^simulate$/],
  ["POST", /^kimi\/verify$/],
];

async function handle(req: Request, params: Promise<{ path: string[] }>) {
  const path = (await params).path.join("/");
  if (!ALLOW.some(([m, r]) => m === req.method && r.test(path))) return NextResponse.json({ error: "route not allowed" }, { status: 404 });
  try {
    const res = await fetch(`${BASE}/${path}${new URL(req.url).search}`, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: req.method === "POST" ? await req.text() : undefined,
      signal: AbortSignal.timeout(60_000),
      cache: "no-store",
    });
    return new NextResponse(res.body, { status: res.status, headers: { "content-type": "application/json" } });
  } catch {
    return NextResponse.json({ error: "services unreachable", missing: ["COPAS_SERVICES_URL"] }, { status: 503 });
  }
}

export const GET = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => handle(req, ctx.params);
export const POST = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => handle(req, ctx.params);
