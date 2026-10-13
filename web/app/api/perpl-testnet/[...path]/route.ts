import { NextResponse } from "next/server";

// Perpl testnet public REST (no CORS for our origin), proxied for the /trade ticket. Read-only market data only.
const BASE = process.env.PERPL_TESTNET_API_URL || "https://testnet.perpl.xyz/api";
const ALLOW = [/^v1\/pub\/context$/, /^v1\/market-data\/ticker$/, /^v1\/market-data\/\d+\/book$/];
const TTL: [RegExp, number][] = [
  [/ticker|book/, 2],
  [/context/, 60],
];

export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join("/");
  if (!ALLOW.some((r) => r.test(path))) return NextResponse.json({ error: "path not allowed" }, { status: 404 });
  const ttl = TTL.find(([r]) => r.test(path))?.[1] ?? 10;
  const levels = new URL(req.url).searchParams.get("levels");
  const qs = levels && /^\d{1,3}$/.test(levels) ? `?levels=${levels}` : "";
  let res: Response;
  try {
    res = await fetch(`${BASE}/${path}${qs}`, { headers: { "User-Agent": "copas-trade/0.1" }, next: { revalidate: ttl }, signal: AbortSignal.timeout(10_000) });
  } catch {
    return NextResponse.json({ error: "perpl testnet unreachable" }, { status: 502 });
  }
  return new NextResponse(res.body, {
    status: res.status,
    headers: { "content-type": "application/json", "cache-control": `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 5}` },
  });
}
