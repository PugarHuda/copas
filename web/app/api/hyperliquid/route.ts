import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { maxDrawdownPct, returnPct, suggestTier, type HlSeries } from "@/lib/hyperliquid";

// Informational track-record import for leader onboarding: public Hyperliquid info API, nothing onchain-verified.
const API = "https://api.hyperliquid.xyz/info";

async function info<T>(body: object): Promise<T> {
  const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000), next: { revalidate: 300 } });
  if (!r.ok) throw new Error(`hyperliquid ${r.status}`);
  return r.json() as Promise<T>;
}

export async function GET(req: Request) {
  const user = new URL(req.url).searchParams.get("user")?.trim() ?? "";
  if (!isAddress(user, { strict: false })) return NextResponse.json({ error: "Enter a 0x address (40 hex characters)." }, { status: 400 });
  try {
    const [portfolio, state] = await Promise.all([
      info<[string, HlSeries][]>({ type: "portfolio", user: user.toLowerCase() }),
      info<{ marginSummary?: { accountValue: string; totalNtlPos: string }; assetPositions?: unknown[] }>({ type: "clearinghouseState", user: user.toLowerCase() }),
    ]);
    const p = Object.fromEntries(Array.isArray(portfolio) ? portfolio : []);
    const all = p.perpAllTime, month = p.perpMonth;
    if (!all || !month) return NextResponse.json({ error: "Hyperliquid returned no portfolio for this address." }, { status: 502 });
    const last = (s: HlSeries) => Number(s.pnlHistory.at(-1)?.[1] ?? 0);
    const accountValue = Number(state.marginSummary?.accountValue ?? 0);
    const notional = Number(state.marginSummary?.totalNtlPos ?? 0);
    const monthDD = maxDrawdownPct(month);
    if (!Number(all.vlm)) return NextResponse.json({ error: "This address has no Hyperliquid perps trades to import." }, { status: 404 });
    return NextResponse.json({
      user: user.toLowerCase(),
      accountValue,
      leverage: accountValue > 0 ? notional / accountValue : 0,
      openPositions: state.assetPositions?.length ?? 0,
      allTime: { pnl: last(all), volume: Number(all.vlm), maxDD: maxDrawdownPct(all), since: all.pnlHistory[0]?.[0] ?? null },
      month: { pnl: last(month), volume: Number(month.vlm), maxDD: monthDD, ret: returnPct(month) },
      suggestion: suggestTier(monthDD),
      fetchedAt: Date.now(),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return NextResponse.json({ error: timeout ? "Hyperliquid did not answer within 8 s. Try again." : "Hyperliquid API request failed. Try again." }, { status: 502 });
  }
}
