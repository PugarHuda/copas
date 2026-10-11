import { NextResponse } from "next/server";
import { PERPL_API } from "@/lib/perpl/api";

// Server-side proxy for Perpl public REST (browser CORS). Only public read paths are allowed.
const ALLOW = [
  /^v1\/pub\/context$/,
  /^v1\/market-data\/ticker$/,
  /^v1\/market-data\/\d+\/(ticker|book)$/,
  /^v1\/market-data\/\d+\/candles\/\d+\/\d+-\d+$/,
  /^v1\/market-data\/(\d+\/)?funding\/\d+-\d+$/,
  /^v1\/trading\/leaderboard\/(day|week|2weeks|month|all)\/(pnl|roi|vol)$/,
];
const TTL: [RegExp, number][] = [
  [/ticker|book/, 3],
  [/leaderboard/, 60],
  [/candles|funding/, 120],
  [/context/, 300],
];

export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const path = (await params).path.join("/");
  if (!ALLOW.some((r) => r.test(path))) return NextResponse.json({ error: "path not allowed" }, { status: 404 });
  const ttl = TTL.find(([r]) => r.test(path))?.[1] ?? 30;
  const qs = new URL(req.url).search;
  const res = await fetch(`${PERPL_API}/${path}${qs}`, { headers: { "User-Agent": "copas-analytics/0.1" }, next: { revalidate: ttl } });
  return new NextResponse(res.body, {
    status: res.status,
    headers: { "content-type": "application/json", "cache-control": `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}` },
  });
}
