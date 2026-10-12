/**
 * Perpl public REST (no auth). Endpoints verified by curl on 3 Oct 2026:
 *   /v1/pub/context, /v1/market-data/ticker, /v1/market-data/:id/candles/:res/:from-:to,
 *   /v1/market-data/funding/:from-:to, /v1/market-data/:id/book, /v1/trading/leaderboard/:period/:sorting
 * Docs: https://github.com/PerplFoundation/api-docs/blob/main/rest-endpoints.md
 * Server-side only (CORS); the browser goes through app/api/perpl/[...path].
 */
export const PERPL_API = process.env.PERPL_API_URL || "https://app.perpl.xyz/api";

export async function perplGet<T>(path: string, revalidate = 10): Promise<T> {
  const res = await fetch(`${PERPL_API}${path}`, {
    headers: { "User-Agent": "copas-analytics/0.1", accept: "application/json" },
    next: { revalidate },
  });
  if (!res.ok) throw new Error(`Perpl ${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export type MarketConfig = {
  is_open: boolean;
  price_decimals: number;
  size_decimals: number;
  initial_margin: number; // max initial leverage, hundredths (1500 = 15x)
  maintenance_margin: number; // maintenance leverage, hundredths (2500 = 25x -> MMF 4%)
  maker_fee: number; // 1/100 bp (45 = 0.45 bp)
  taker_fee: number;
};
export type MarketState = {
  at: { b: number; t: number };
  orl: number;
  mrk: number;
  lst: number;
  mid: number;
  bid: number;
  ask: number;
  prv: number;
  dv: number;
  dva: string;
  oi: number;
  tvl: string;
};
export type FundingEvent = { at: { b: number; t: number }; feb: number; rate: number; idx: number; ppl: number; sum: number; div: number };
export type ContextMarket = {
  id: number;
  name: string;
  funding_interval_sec: number;
  config: MarketConfig;
  state?: MarketState;
  funding?: FundingEvent;
};
export type PerplContext = { chain: { chain_id: number }; markets: ContextMarket[] };
export type Candle = { t: number; o: number; c: number; h: number; l: number; v: string; n: number };

export type LbPeriod = "day" | "week" | "2weeks" | "month" | "all";
export type LbSort = "pnl" | "roi" | "vol";
export const LB_PERIODS: LbPeriod[] = ["day", "week", "2weeks", "month", "all"];
/** Raw row: i rank, a address, p pnl (CNS 6dp), r roi (1/100 %), v volume (CNS 6dp), s score. */
export type LbRowRaw = { i: number; a: string; p: string; r: number; v: string; s?: string };
export type LbRow = { rank: number; address: string; pnl: number; roi: number; volume: number };

export const cns = (v: string | number | bigint) => Number(v) / 1e6;

export const getContext = () => perplGet<PerplContext>("/v1/pub/context", 300);
export const getTicker = () => perplGet<{ sn: number; d: Record<string, MarketState> }>("/v1/market-data/ticker", 5);

export async function getLeaderboard(period: LbPeriod, sorting: LbSort): Promise<LbRow[]> {
  const r = await perplGet<{ d: LbRowRaw[] }>(`/v1/trading/leaderboard/${period}/${sorting}`, 60);
  return r.d.map((x) => ({ rank: x.i, address: x.a.toLowerCase(), pnl: cns(x.p), roi: x.r / 100, volume: cns(x.v) }));
}

export async function getCandles(market: number, res: number, from: number, to: number) {
  const r = await perplGet<{ d: Candle[] }>(`/v1/market-data/${market}/candles/${res}/${from}-${to}`, 300);
  return r.d;
}

/** L2 book snapshot, up to 100 levels a side (raw price/size units, best level first). */
export const getBook = (market: number) =>
  perplGet<{ sn: number; bid: { p: number; s: number; o: number }[]; ask: { p: number; s: number; o: number }[] }>(`/v1/market-data/${market}/book?levels=100`, 15);

/** All-market funding, at most 128 intervals of the shortest market interval per request. */
export async function getFundingAll(from: number, to: number) {
  const r = await perplGet<{ d: Record<string, FundingEvent[]> }>(`/v1/market-data/funding/${from}-${to}`, 120);
  return r.d;
}

/** Market metadata with human scales. */
export type Market = {
  id: number;
  name: string;
  pd: number;
  sd: number;
  maxLev: number;
  maintLev: number;
  fundingIntervalSec: number;
  takerBp: number;
  makerBp: number;
};
export function toMarkets(ctx: PerplContext): Market[] {
  return ctx.markets
    .filter((m) => m.config.is_open)
    .map((m) => ({
      id: m.id,
      name: m.name,
      pd: m.config.price_decimals,
      sd: m.config.size_decimals,
      maxLev: m.config.initial_margin / 100,
      maintLev: m.config.maintenance_margin / 100,
      fundingIntervalSec: m.funding_interval_sec,
      takerBp: m.config.taker_fee / 100,
      makerBp: m.config.maker_fee / 100,
    }));
}
export const getMarkets = async () => toMarkets(await getContext());
