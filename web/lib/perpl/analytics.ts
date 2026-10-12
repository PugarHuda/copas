import "server-only";
import { unstable_cache } from "next/cache";
import { getBook, getCandles, getContext, getFundingAll, getLeaderboard, getTicker, cns, toMarkets, LB_PERIODS, type LbPeriod, type Market } from "./api";
import { accountByAddr, accountById, addressesFor, allPositions, equityCurve, exchangeInfo, perpInfos, tvlCurve, type Position } from "./onchain";
import { BLOCKS_PER_DAY, accountWord, dataWord, decode, ev, scan, timeline } from "./logs";
import { computeTradeStats, type Trade } from "./stats";
import { cohorts, depth, fundingApr, liqWithin, mid, profitConcentration, slippageBps, type AccountRow } from "./riskmath";
import { envioAll, indexerFresh, indexerUrl, indexerFlows, indexerTvlCurve, indexerWalletEquity, indexerWalletFlows, indexerWalletTrades } from "./indexer";

const DAY = 86_400_000;
/** Cache-key part so toggling the indexer env never serves entries built from the other source. */
const SRC = indexerUrl() || "rpc";

export const markets = unstable_cache(async () => toMarkets(await getContext()), ["perpl-markets"], { revalidate: 600 });

/* ---------------------------------- protocol --------------------------------- */

export type MarketRow = {
  id: number;
  name: string;
  mark: number;
  change24h: number;
  vol24h: number;
  oiNotional: number;
  tvl: number;
  longTraders: number;
  shortTraders: number;
  longMargin: number;
  shortMargin: number;
  longUpnl: number;
  shortUpnl: number;
  fundingRate: number; // per interval, fraction
  fundingApr: number; // %
  insurance: number;
  maxLev: number;
  takerBp: number;
};

export type RiskPosition = Pick<Position, "market" | "marketId" | "accountId" | "side" | "notional" | "leverage" | "liq" | "liqDistance" | "mark" | "upnl"> & { address?: string };

export const protocolSnapshot = unstable_cache(
  async () => {
    const ms = await markets();
    const [ticker, ex, infos, positions, ctx] = await Promise.all([
      getTicker(),
      exchangeInfo(),
      perpInfos(ms),
      Promise.all(ms.map((m) => allPositions(m).catch(() => [] as Position[]))),
      getContext(),
    ]);
    const fundingById = new Map(ctx.markets.map((m) => [m.id, m.funding?.rate ?? 0]));
    const rows: MarketRow[] = ms.map((m, i) => {
      const s = ticker.d[String(m.id)];
      const ps = positions[i];
      const mark = s ? s.mrk / 10 ** m.pd : (infos[i]?.mark ?? 0);
      const L = ps.filter((p) => p.side === "long");
      const S = ps.filter((p) => p.side === "short");
      const rate = (fundingById.get(m.id) ?? 0) / 1e6;
      return {
        id: m.id,
        name: m.name,
        mark,
        change24h: s && s.prv ? ((s.mrk - s.prv) / s.prv) * 100 : 0,
        vol24h: s ? cns(s.dva) : 0,
        oiNotional: s ? (s.oi / 10 ** m.sd) * mark : (infos[i]?.oiBase ?? 0) * mark,
        tvl: s ? cns(s.tvl) : 0,
        longTraders: L.length,
        shortTraders: S.length,
        longMargin: L.reduce((a, p) => a + p.margin, 0),
        shortMargin: S.reduce((a, p) => a + p.margin, 0),
        longUpnl: L.reduce((a, p) => a + p.upnl, 0),
        shortUpnl: S.reduce((a, p) => a + p.upnl, 0),
        fundingRate: rate,
        fundingApr: rate * ((365 * 86400) / m.fundingIntervalSec) * 100,
        insurance: infos[i]?.insurance ?? 0,
        maxLev: m.maxLev,
        takerBp: m.takerBp,
      };
    });
    const all = positions.flat();
    const atRisk = all
      .filter((p) => p.liqDistance != null && p.notional >= 50)
      .sort((a, b) => a.liqDistance! - b.liqDistance!)
      .slice(0, 15);
    const largest = [...all].sort((a, b) => b.notional - a.notional).slice(0, 15);
    const addr = await addressesFor([...atRisk, ...largest].map((p) => p.accountId)).catch(() => new Map<number, string>());
    const pick = (p: Position): RiskPosition => ({
      market: p.market,
      marketId: p.marketId,
      accountId: p.accountId,
      side: p.side,
      notional: p.notional,
      leverage: p.leverage,
      liq: p.liq,
      liqDistance: p.liqDistance,
      mark: p.mark,
      upnl: p.upnl,
      address: addr.get(p.accountId),
    });
    // Liquidation ladder input: [marketId, side 0/1, liqPrice, notional]
    const ladder = all.filter((p) => p.liq).map((p) => [p.marketId, p.side === "long" ? 0 : 1, p.liq!, p.notional] as const);
    return {
      at: Date.now(),
      block: ticker.sn,
      tvl: ex.tvl,
      protocolBalance: ex.protocolBalance,
      accounts: ex.accounts,
      openPositions: all.length,
      rows,
      atRisk: atRisk.map(pick),
      largest: largest.map(pick),
      ladder,
    };
  },
  ["perpl-protocol"],
  { revalidate: 20 },
);

/** Daily volume per market from 1d candles (v = collateral notional). */
export const volumeHistory = unstable_cache(
  async () => {
    const ms = await markets();
    const to = Date.now();
    const from = to - 1000 * DAY;
    const series = await Promise.all(ms.map((m) => getCandles(m.id, 86400, from, to).catch(() => [])));
    const byDay = new Map<number, { t: number; total: number; per: Record<string, number>; trades: number }>();
    series.forEach((cs, i) =>
      cs.forEach((c) => {
        const v = cns(c.v);
        if (!v) return;
        const d = byDay.get(c.t) ?? { t: c.t, total: 0, per: {}, trades: 0 };
        d.total += v;
        d.trades += c.n;
        d.per[ms[i].name] = (d.per[ms[i].name] ?? 0) + v;
        byDay.set(c.t, d);
      }),
    );
    const days = [...byDay.values()].sort((a, b) => a.t - b.t);
    const sumSince = (ms_: number) => days.filter((d) => d.t >= to - ms_).reduce((a, d) => a + d.total, 0);
    const share: Record<string, number> = {};
    days.filter((d) => d.t >= to - 30 * DAY).forEach((d) => Object.entries(d.per).forEach(([k, v]) => (share[k] = (share[k] ?? 0) + v)));
    return {
      days,
      v7d: sumSince(7 * DAY),
      v30d: sumSince(30 * DAY),
      vAll: days.reduce((a, d) => a + d.total, 0),
      share30d: Object.entries(share).sort((a, b) => b[1] - a[1]),
      firstDay: days[0]?.t,
    };
  },
  ["perpl-volume"],
  { revalidate: 900 },
);

/** Active traders = accounts with volume > 0 in the leaderboard window. */
export const activeUsers = unstable_cache(
  async () => {
    const periods: LbPeriod[] = ["day", "week", "month", "all"];
    const lbs = await Promise.all(periods.map((p) => getLeaderboard(p, "vol")));
    const out: Record<string, { active: number; profitable: number; pnlSum: number }> = {};
    periods.forEach((p, i) => {
      const act = lbs[i].filter((r) => r.volume > 0);
      out[p] = { active: act.length, profitable: act.filter((r) => r.pnl > 0).length, pnlSum: act.reduce((a, r) => a + r.pnl, 0) };
    });
    return out;
  },
  ["perpl-active"],
  { revalidate: 120 },
);

/** Funding: last ~3.5 days of events for every market (128 intervals cap). */
export const fundingHistory = unstable_cache(
  async () => {
    const ms = await markets();
    const to = Date.now();
    const shortest = Math.min(...ms.map((m) => m.fundingIntervalSec));
    const d = await getFundingAll(to - 120 * shortest * 1000, to);
    return ms
      .filter((m) => d[String(m.id)]?.length)
      .map((m) => {
        const evs = d[String(m.id)];
        const perYear = (365 * 86400) / m.fundingIntervalSec;
        const pts = evs.map((e) => ({ t: e.at.t, apr: (e.rate / 1e6) * perYear * 100 }));
        const last24 = pts.filter((p) => p.t >= to - DAY);
        return {
          id: m.id,
          name: m.name,
          points: pts,
          current: pts[pts.length - 1]?.apr ?? 0,
          avg24h: last24.length ? last24.reduce((a, p) => a + p.apr, 0) / last24.length : 0,
        };
      });
  },
  ["perpl-funding"],
  { revalidate: 300 },
);

/* -------------------------------- flows & liqs -------------------------------- */

export type FlowEvent = { t: number; block: number; tx: string; kind: "deposit" | "withdrawal"; accountId: number; amount: number; address?: string };
export type LiqEvent = { t: number; block: number; tx: string; accountId: number; market: string; side: "long" | "short"; price: number; notional: number; pnl: number; address?: string };

/**
 * Window for log-derived flows/liquidations. ponytail: public RPC caps getLogs at 10k blocks,
 * so 7 days = ~150 requests (~8s, cached 120s). Longer history needs the Envio indexer.
 */
export const FLOW_DAYS = Number(process.env.FLOWS_SCAN_DAYS || 7);

/** Deposits, withdrawals and liquidations: full history from the indexer (days = null), else the last `days` days of logs. */
export const flows = unstable_cache(
  async (days: number) => {
    if (await indexerFresh()) {
      const f = await indexerFlows().catch(() => null);
      if (f) return { source: "envio" as const, ...f };
    }
    return { source: "rpc" as const, ...(await rpcFlows(days)) };
  },
  ["perpl-flows-src", SRC],
  { revalidate: 120 },
);

const rpcFlows = unstable_cache(
  async (days: number) => {
    const ms = await markets();
    const byId = new Map(ms.map((m) => [m.id, m]));
    const [dep, wd, liq] = [ev("CollateralDeposit"), ev("CollateralWithdrawal"), ev("PositionLiquidated")];
    const { head, start, logs } = await scan([dep, wd, liq], BigInt(days) * BLOCKS_PER_DAY);
    const at = await timeline(start, head);
    const flowsOut: FlowEvent[] = [];
    const liqs: LiqEvent[] = [];
    for (const l of logs) {
      const block = Number(l.blockNumber);
      const base = { t: at(block), block, tx: l.transactionHash ?? "" };
      const d = decode(l);
      if (d.eventName === "CollateralDeposit" || d.eventName === "CollateralWithdrawal") {
        flowsOut.push({ ...base, kind: d.eventName === "CollateralDeposit" ? "deposit" : "withdrawal", accountId: Number(d.args.accountId), amount: Number(d.args.amountCNS) / 1e6 });
      } else if (d.eventName === "PositionLiquidated") {
        const m = byId.get(Number(d.args.perpId));
        if (!m) continue;
        const px = Number(d.args.liqPricePNS) / 10 ** m.pd;
        liqs.push({
          ...base,
          accountId: Number(d.args.posAccountId),
          market: m.name,
          side: d.args.positionType === 0 ? "long" : "short",
          price: px,
          notional: (Number(d.args.liqLotLNS) / 10 ** m.sd) * px,
          pnl: Number(d.args.deltaPnlCNS + d.args.fundingCNS) / 1e6,
        });
      }
    }
    const daily = new Map<number, { t: number; deposits: number; withdrawals: number; liqCount: number; liqNotional: number }>();
    const bucket = (t: number) => {
      const k = Math.floor(t / DAY) * DAY;
      const v = daily.get(k) ?? { t: k, deposits: 0, withdrawals: 0, liqCount: 0, liqNotional: 0 };
      daily.set(k, v);
      return v;
    };
    flowsOut.forEach((f) => (f.kind === "deposit" ? (bucket(f.t).deposits += f.amount) : (bucket(f.t).withdrawals += f.amount)));
    liqs.forEach((l) => {
      const b = bucket(l.t);
      b.liqCount++;
      b.liqNotional += l.notional;
    });
    flowsOut.sort((a, b) => b.block - a.block);
    liqs.sort((a, b) => b.block - a.block);
    const recentIds = [...flowsOut.slice(0, 40), ...liqs.slice(0, 40)].map((x) => x.accountId);
    const addr = await addressesFor(recentIds).catch(() => new Map<number, string>());
    const withAddr = <T extends { accountId: number }>(x: T) => ({ ...x, address: addr.get(x.accountId) });
    return {
      days,
      from: at(Number(start)),
      daily: [...daily.values()].sort((a, b) => a.t - b.t),
      totals: {
        deposits: flowsOut.filter((f) => f.kind === "deposit").reduce((a, f) => a + f.amount, 0),
        withdrawals: flowsOut.filter((f) => f.kind === "withdrawal").reduce((a, f) => a + f.amount, 0),
        liqCount: liqs.length,
        liqNotional: liqs.reduce((a, l) => a + l.notional, 0),
      },
      all: flowsOut.map((f) => [f.t, f.accountId, f.kind === "deposit" ? f.amount : -f.amount, f.tx] as const),
      recentFlows: flowsOut.slice(0, 40).map(withAddr),
      recentLiqs: liqs.slice(0, 40).map(withAddr),
      liqsAll: liqs,
    };
  },
  ["perpl-flows"],
  { revalidate: 120 },
);

export const tvlHistory = unstable_cache(
  async () => {
    if (await indexerFresh()) {
      const pts = await indexerTvlCurve().catch(() => null);
      if (pts?.length) return { source: "envio" as const, pts };
    }
    return { source: "rpc" as const, pts: await tvlCurve(48) };
  },
  ["perpl-tvl-src", SRC],
  { revalidate: 300 },
);

/* ----------------------------------- wallet ----------------------------------- */

// Not wrapped in unstable_cache: 5 x 5k rows exceeds its 2MB entry limit. Each fetch is cached on its own.
const leaderboardsByPnl = async () =>
  Object.fromEntries(await Promise.all(LB_PERIODS.map(async (p) => [p, await getLeaderboard(p, "pnl")] as const)));

export async function walletPeriods(address: string) {
  const lbs = await leaderboardsByPnl();
  const a = address.toLowerCase();
  return LB_PERIODS.map((p) => {
    const r = lbs[p].find((x) => x.address === a);
    return { period: p, rank: r?.rank ?? null, of: lbs[p].length, pnl: r?.pnl ?? null, roi: r?.roi ?? null, volume: r?.volume ?? null };
  });
}

export const walletSnapshot = unstable_cache(
  async (address: string) => {
    const ms = await markets();
    if (/^\d+$/.test(address)) return accountById(ms, Number(address));
    return accountByAddr(ms, address as `0x${string}`);
  },
  ["perpl-wallet"],
  { revalidate: 10 },
);

export const walletEquityCurve = unstable_cache(
  async (accountId: number) => {
    if (await indexerFresh()) {
      const pts = await indexerWalletEquity(accountId).catch(() => null);
      if (pts) return { source: "envio" as const, pts };
    }
    return { source: "rpc" as const, pts: await equityCurve(await markets(), accountId, 40) };
  },
  ["perpl-wallet-equity-src", SRC],
  { revalidate: 300 },
);

/**
 * RPC window for trade history when no indexer is configured. Position events run
 * ~130k logs/day (~140MB of JSON), so without Envio we only scan recent hours.
 */
export const TRADE_WINDOW_HOURS = Number(process.env.TRADE_SCAN_HOURS || 6);

export const walletTrades = unstable_cache(
  async (accountId: number) => {
    if (await indexerFresh()) {
      const trades = await indexerWalletTrades(accountId).catch(() => null);
      if (trades) {
        // ponytail: stats use every trade; list and curve are thinned so the entry stays under unstable_cache's 2MB cap
        const stats = computeTradeStats(trades);
        const step = Math.ceil(stats.curve.length / 1000);
        stats.curve = stats.curve.filter((_, i, a) => i % step === 0 || i === a.length - 1);
        return { source: "envio" as const, windowHours: null, trades: trades.slice(0, 500), stats };
      }
    }
    const trades = await rpcWalletTrades(accountId, await markets(), TRADE_WINDOW_HOURS);
    return { source: "rpc" as const, windowHours: TRADE_WINDOW_HOURS, trades, stats: computeTradeStats(trades) };
  },
  ["perpl-wallet-trades", SRC],
  { revalidate: 120 },
);

const TRADE_EVENTS = ["PositionOpened", "PositionOpenedV2", "PositionIncreased", "PositionIncreasedV2", "PositionDecreased", "PositionClosed", "PositionLiquidated", "PositionDeleveragedV2"];

/** Rebuild round-trip trades for one account from position events (open -> partial closes -> close/liquidation). */
async function rpcWalletTrades(accountId: number, ms: Market[], hours: number): Promise<Trade[]> {
  const byId = new Map(ms.map((m) => [m.id, m]));
  const word = accountWord(accountId);
  const { head, start, logs } = await scan(TRADE_EVENTS.map(ev), (BigInt(hours) * BLOCKS_PER_DAY) / 24n);
  const mine = logs.filter((l) => dataWord(l.data, 1) === word).sort((a, b) => Number(a.blockNumber! - b.blockNumber!) || a.logIndex! - b.logIndex!);
  if (!mine.length) return [];
  const at = await timeline(start, head);
  const open = new Map<number, Trade>();
  const done: Trade[] = [];
  for (const l of mine) {
    const d = decode(l);
    const args = d.args as Record<string, unknown>;
    const m = byId.get(Number(args.perpId));
    if (!m) continue;
    const t = at(Number(l.blockNumber));
    const side = Number(args.positionType) === 0 ? "long" : "short";
    const cur = open.get(m.id);
    const pnlOf = () => Number((args.deltaPnlCNS as bigint) + (args.fundingCNS as bigint)) / 1e6;
    switch (d.eventName) {
      case "PositionOpened":
      case "PositionOpenedV2": {
        const size = Number(args.lotLNS) / 10 ** m.sd;
        const px = Number(args.pricePNS) / 10 ** m.pd;
        open.set(m.id, { market: m.name, side, openedAt: t, closedAt: null, entry: px, maxNotional: size * px, pnl: 0, liquidated: false, tx: l.transactionHash ?? "" });
        break;
      }
      case "PositionIncreased":
      case "PositionIncreasedV2":
        if (cur) cur.maxNotional = Math.max(cur.maxNotional, (Number(args.endLotLNS) / 10 ** m.sd) * Number(args.pricePNS) / 10 ** m.pd);
        break;
      case "PositionDecreased":
        if (cur) cur.pnl += pnlOf();
        else open.set(m.id, { market: m.name, side, openedAt: null, closedAt: null, entry: null, maxNotional: 0, pnl: pnlOf(), liquidated: false, tx: l.transactionHash ?? "" });
        break;
      case "PositionClosed":
      case "PositionLiquidated":
      case "PositionDeleveragedV2": {
        if (d.eventName === "PositionDeleveragedV2" && !args.forceClose && Number(args.endLotLNS) > 0) {
          if (cur) cur.pnl += pnlOf();
          break;
        }
        const tr: Trade = cur ?? { market: m.name, side, openedAt: null, closedAt: null, entry: null, maxNotional: 0, pnl: 0, liquidated: false, tx: "" };
        tr.pnl += pnlOf();
        tr.closedAt = t;
        tr.exit = d.eventName === "PositionClosed" ? Number(args.pricePNS) / 10 ** m.pd : d.eventName === "PositionLiquidated" ? Number(args.liqPricePNS) / 10 ** m.pd : null;
        tr.liquidated = d.eventName === "PositionLiquidated";
        tr.tx = l.transactionHash ?? tr.tx;
        done.push(tr);
        open.delete(m.id);
        break;
      }
    }
  }
  return done.sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
}

export async function walletFlows(accountId: number) {
  if (await indexerFresh()) {
    const rows = await indexerWalletFlows(accountId).catch(() => null);
    if (rows) return { source: "envio" as const, rows };
  }
  const f = await rpcFlows(FLOW_DAYS);
  return { source: "rpc" as const, rows: f.all.filter((x) => x[1] === accountId).map(([t, , amount, tx]) => ({ t, amount, tx })) };
}

/* ------------------------------ risk (Envio + book) ------------------------------ */

/**
 * Per-market daily history from Envio MarketDaily (full indexed history, not the API's 128-interval window):
 * funding APR per day, open interest and liquidated notional per day.
 */
export const marketHistory = unstable_cache(
  async (days: number) => {
    const ms = await markets();
    const byId = new Map(ms.map((m) => [String(m.id), m]));
    const since = Math.floor((Date.now() - days * DAY) / DAY) * 86400;
    const rows = await envioAll<{ date: number; market_id: string; fundingEvents: number; sumFundingRatePct100k: string; openInterestCNS: string; liquidatedNotionalCNS: string; volumeCNS: string }>(
      "MarketDaily",
      `where: { chainId: { _eq: $chain }, date: { _gte: $since } }, order_by: [{ date: asc }, { id: asc }]`,
      "date market_id fundingEvents sumFundingRatePct100k openInterestCNS liquidatedNotionalCNS volumeCNS",
      { since },
      ", $since: Int!",
    );
    const dates = [...new Set(rows.map((r) => r.date * 1000))].sort((a, b) => a - b);
    const per = new Map<string, { id: number; name: string; funding: (number | null)[]; oi: number[]; liq: number[]; vol: number }>();
    for (const r of rows) {
      const m = byId.get(r.market_id);
      if (!m) continue; // delisted / not in the live context
      const s = per.get(r.market_id) ?? { id: m.id, name: m.name, funding: dates.map(() => null), oi: dates.map(() => 0), liq: dates.map(() => 0), vol: 0 };
      const i = dates.indexOf(r.date * 1000);
      s.funding[i] = fundingApr(Number(r.sumFundingRatePct100k), r.fundingEvents, m.fundingIntervalSec);
      s.oi[i] = cns(r.openInterestCNS);
      s.liq[i] = cns(r.liquidatedNotionalCNS);
      s.vol += cns(r.volumeCNS);
      per.set(r.market_id, s);
    }
    // OI is a snapshot at the day's last event: carry it over days without events
    for (const s of per.values()) for (let i = 1; i < s.oi.length; i++) if (!s.oi[i]) s.oi[i] = s.oi[i - 1];
    return { dates, markets: [...per.values()].filter((s) => s.vol > 0).sort((a, b) => b.oi[b.oi.length - 1] - a.oi[a.oi.length - 1]) };
  },
  ["perpl-market-history"],
  { revalidate: 900 },
);

/** Every mainnet trader (Envio Account), bucketed by lifetime volume. Realized PnL after fees; open positions excluded. */
export const traderCohorts = unstable_cache(
  async () => {
    const rows = await envioAll<{ volumeCNS: string; netPnlCNS: string; feesCNS: string; liquidations: number; wins: number; losses: number }>(
      "Account",
      `where: { chainId: { _eq: $chain }, fills: { _gt: 0 } }, order_by: { id: asc }`,
      "volumeCNS netPnlCNS feesCNS liquidations wins losses",
    );
    const accts: AccountRow[] = rows.map((r) => ({ volume: cns(r.volumeCNS), netPnl: cns(r.netPnlCNS), fees: cns(r.feesCNS), liquidations: r.liquidations, wins: r.wins, losses: r.losses }));
    return {
      traders: accts.length,
      profitable: accts.filter((a) => a.netPnl > 0).length,
      netPnl: accts.reduce((s, a) => s + a.netPnl, 0),
      fees: accts.reduce((s, a) => s + a.fees, 0),
      top1: profitConcentration(accts, 1),
      cohorts: cohorts(accts),
    };
  },
  ["perpl-cohorts"],
  { revalidate: 900 },
);

/**
 * Order-book liquidity vs liquidation pressure per market: Perpl REST /book (100 levels a side) against the
 * liquidation prices of every open position (protocolSnapshot ladder).
 */
export const bookRisk = unstable_cache(
  async () => {
    const [ms, p] = await Promise.all([markets(), protocolSnapshot()]);
    const books = await Promise.all(ms.map((m) => getBook(m.id).catch(() => null)));
    return ms.flatMap((m, i) => {
      const raw = books[i];
      if (!raw?.bid.length || !raw.ask.length) return [];
      const lv = (x: { p: number; s: number }) => ({ p: x.p / 10 ** m.pd, s: x.s / 10 ** m.sd });
      const b = { bid: raw.bid.map(lv), ask: raw.ask.map(lv) };
      const md = mid(b);
      const mark = p.rows.find((r) => r.id === m.id)?.mark || md;
      const liq = liqWithin(p.ladder, m.id, mark, 5);
      const bid5 = depth(b.bid, md, 5);
      const ask5 = depth(b.ask, md, 5);
      return [{
        id: m.id,
        name: m.name,
        block: raw.sn,
        spreadBps: ((b.ask[0].p - b.bid[0].p) / md) * 1e4,
        bid1: depth(b.bid, md, 1),
        ask1: depth(b.ask, md, 1),
        bid5,
        ask5,
        sell10k: slippageBps(b.bid, md, 1e4),
        buy10k: slippageBps(b.ask, md, 1e4),
        sell100k: slippageBps(b.bid, md, 1e5),
        buy100k: slippageBps(b.ask, md, 1e5),
        longLiq5: liq.longs,
        shortLiq5: liq.shorts,
      }];
    });
  },
  ["perpl-book-risk"],
  { revalidate: 30 },
);
