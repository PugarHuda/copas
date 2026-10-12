import { NextResponse } from "next/server";

/** Proxy to @copas/onramp (copas/onramp, hosted as copas-onramp). Only the routes the funding panel uses. */
const BASE = process.env.ONRAMP_URL || "http://localhost:8787";
const ALLOW: [string, RegExp][] = [
  ["POST", /^aurora\/(quote|deposit-address)$/],
  ["GET", /^aurora\/status\/[A-Za-z0-9]{20,100}$/],
  ["POST", /^kuru\/quote$/],
  ["POST", /^socket\/deposit-address$/],
  ["GET", /^socket\/status\/0x[0-9a-fA-F]{64}$/],
];

async function handle(req: Request, params: Promise<{ path: string[] }>) {
  const path = (await params).path.join("/");
  if (!ALLOW.some(([m, r]) => m === req.method && r.test(path))) return NextResponse.json({ error: "route not allowed" }, { status: 404 });
  try {
    const res = await fetch(`${BASE}/${path}`, {
      method: req.method,
      headers: { "content-type": "application/json" },
      body: req.method === "POST" ? await req.text() : undefined,
      signal: AbortSignal.timeout(70_000),
      cache: "no-store",
    });
    return new NextResponse(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "onramp unreachable", missing: ["ONRAMP_URL"] }, { status: 503 });
  }
}

export const maxDuration = 90;
export const GET = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => handle(req, ctx.params);
export const POST = (req: Request, ctx: { params: Promise<{ path: string[] }> }) => handle(req, ctx.params);
