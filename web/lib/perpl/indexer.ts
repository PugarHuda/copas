import "server-only";
import type { Trade } from "./stats";

/**
 * Envio HyperIndex adapter (copas/indexer, schema: copas/indexer/schema.graphql).
 * When NEXT_PUBLIC_ENVIO_GRAPHQL_URL is set, history comes from the indexer (full history)
 * instead of the windowed RPC scans in lib/perpl/logs.ts / onchain.ts. Callers fall back to
 * RPC when a query throws. Money fields are AUSD CNS (6 decimals), prices PNS (Market.priceDecimals).
 */
export const indexerUrl = () => process.env.NEXT_PUBLIC_ENVIO_GRAPHQL_URL || "";
export const indexerConfigured = () => !!indexerUrl();

/** Rows are per chain; the Perpl dashboard is mainnet. */
const CHAIN = 143;
const DAY = 86_400_000;
const cns = (x: string | number) => Number(x) / 1e6;

export async function envioQuery<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const secret = process.env.ENVIO_GRAPHQL_SECRET; // server-only: Hasura admin secret for a local indexer
  const res = await fetch(indexerUrl(), {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { "x-hasura-admin-secret": secret } : {}) },
    body: JSON.stringify({ query, variables: { chain: CHAIN, ...variables } }),
    cache: "no-store", // callers cache via unstable_cache; wallet histories can exceed the 2MB fetch-cache cap
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || j.errors?.length) throw new Error(j.errors?.[0]?.message ?? `envio ${res.status}`);
  return j.data as T;
}

// A cloud indexer still backfilling would show stale analytics; use it only once it is near head.
// ponytail: per-instance 60s memo, fine for a dashboard
let fresh: { at: number; ok: Promise<boolean> } | undefined;
export function indexerFresh(maxLagMs = DAY): Promise<boolean> {
  if (!indexerConfigured()) return Promise.resolve(false);
  if (!fresh || Date.now() - fresh.at > 60_000)
    fresh = { at: Date.now(), ok: indexerSyncedAt().then((t) => Date.now() - t < maxLagMs).catch(() => false) };
  return fresh.ok;
}

/** Timestamp (ms) of the last mainnet event the indexer has processed. */
export async function indexerSyncedAt(): Promise<number> {
  const d = await envioQuery<{ Protocol: { lastUpdatedAt: number }[] }>(`query($chain: Int!) { Protocol(where: { chainId: { _eq: $chain } }) { lastUpdatedAt } }`);
  return (d.Protocol[0]?.lastUpdatedAt ?? 0) * 1000;
}

/* ---------------------------------- wallet ---------------------------------- */

type ClosedRow = {
  side: "LONG" | "SHORT";
  reason: string;
  entryPricePNS: string;
  exitPricePNS: string;
  maxNotionalCNS: string;
  pnlCNS: string;
  openedAt: number;
  closedAt: number;
  closeTx: string;
  market: { symbol: string; priceDecimals: number } | null;
};

/** Every closed round trip for one account (ClosedTrade), newest first. */
export async function indexerWalletTrades(accountId: number): Promise<Trade[]> {
  const d = await envioQuery<{ ClosedTrade: ClosedRow[] }>(
    `query($chain: Int!, $acc: String!) { ClosedTrade(where: { chainId: { _eq: $chain }, account_id: { _eq: $acc } }, order_by: { closedAt: desc }) {
      side reason entryPricePNS exitPricePNS maxNotionalCNS pnlCNS openedAt closedAt closeTx market { symbol priceDecimals } } }`,
    { acc: String(accountId) },
  );
  return d.ClosedTrade.map((r) => {
    const px = (x: string) => (r.market ? Number(x) / 10 ** r.market.priceDecimals : null);
    return {
      market: r.market?.symbol ?? "?",
      side: r.side === "SHORT" ? "short" : "long",
      openedAt: r.openedAt * 1000,
      closedAt: r.closedAt * 1000,
      entry: px(r.entryPricePNS),
      exit: px(r.exitPricePNS),
      maxNotional: cns(r.maxNotionalCNS),
      pnl: cns(r.pnlCNS), // price pnl + funding, before fees (same as the RPC path)
      liquidated: r.reason === "LIQUIDATED",
      tx: r.closeTx,
    };
  });
}

type FlowRow = { kind: "DEPOSIT" | "WITHDRAWAL"; amountCNS: string; timestamp: number; block: number; txHash: string; account: { accountId: string; address: string | null } | null };
const FLOW_FIELDS = `kind amountCNS timestamp block txHash account { accountId address }`;

/** All deposits/withdrawals of one account, newest first; amount signed (+deposit). */
export async function indexerWalletFlows(accountId: number) {
  const d = await envioQuery<{ CollateralFlow: FlowRow[] }>(
    `query($chain: Int!, $acc: String!) { CollateralFlow(where: { chainId: { _eq: $chain }, account_id: { _eq: $acc }, kind: { _in: [DEPOSIT, WITHDRAWAL] } }, order_by: { timestamp: desc }) { ${FLOW_FIELDS} } }`,
    { acc: String(accountId) },
  );
  return d.CollateralFlow.map((f) => ({ t: f.timestamp * 1000, amount: f.kind === "DEPOSIT" ? cns(f.amountCNS) : -cns(f.amountCNS), tx: f.txHash }));
}

/**
 * Daily realized equity: net deposits + cumulative net PnL (realized - fees), from AccountDaily
 * and CollateralFlow. ponytail: excludes unrealized PnL; the live snapshot covers open positions.
 */
export async function indexerWalletEquity(accountId: number) {
  const [d, flows] = await Promise.all([
    envioQuery<{ AccountDaily: { date: number; cumNetPnlCNS: string }[] }>(
      `query($chain: Int!, $acc: String!) { AccountDaily(where: { chainId: { _eq: $chain }, account_id: { _eq: $acc } }, order_by: { date: asc }) { date cumNetPnlCNS } }`,
      { acc: String(accountId) },
    ),
    indexerWalletFlows(accountId),
  ]);
  const pnlByDay = new Map(d.AccountDaily.map((r) => [r.date * 1000, cns(r.cumNetPnlCNS)]));
  const days = [...new Set([...pnlByDay.keys(), ...flows.map((f) => Math.floor(f.t / DAY) * DAY)])].sort((a, b) => a - b);
  let pnl = 0;
  return days.map((t) => {
    pnl = pnlByDay.get(t) ?? pnl;
    const net = flows.filter((f) => f.t < t + DAY).reduce((a, f) => a + f.amount, 0);
    return { t: t + DAY - 1, equity: net + pnl };
  });
}

/* --------------------------------- protocol --------------------------------- */

type LiqRow = {
  side: "LONG" | "SHORT";
  liqPricePNS: string;
  notionalCNS: string;
  pnlCNS: string;
  fundingCNS: string;
  timestamp: number;
  block: number;
  txHash: string;
  market: { symbol: string; priceDecimals: number } | null;
  account: { accountId: string; address: string | null } | null;
};

/** Same shape as analytics.flows(), over the whole indexed history (days = null). */
export async function indexerFlows() {
  const d = await envioQuery<{
    ProtocolDaily: { date: number; depositsCNS: string; withdrawalsCNS: string; liquidations: number; liquidatedNotionalCNS: string }[];
    CollateralFlow: FlowRow[];
    Liquidation: LiqRow[];
  }>(
    `query($chain: Int!) {
      ProtocolDaily(where: { chainId: { _eq: $chain } }, order_by: { date: asc }) { date depositsCNS withdrawalsCNS liquidations liquidatedNotionalCNS }
      CollateralFlow(where: { chainId: { _eq: $chain }, kind: { _in: [DEPOSIT, WITHDRAWAL] } }, order_by: { timestamp: desc }, limit: 40) { ${FLOW_FIELDS} }
      Liquidation(where: { chainId: { _eq: $chain } }, order_by: { timestamp: desc }, limit: 5000) {
        side liqPricePNS notionalCNS pnlCNS fundingCNS timestamp block txHash market { symbol priceDecimals } account { accountId address } }
    }`,
  );
  const daily = d.ProtocolDaily.map((r) => ({ t: r.date * 1000, deposits: cns(r.depositsCNS), withdrawals: cns(r.withdrawalsCNS), liqCount: r.liquidations, liqNotional: cns(r.liquidatedNotionalCNS) }));
  const liqs = d.Liquidation.map((l) => ({
    t: l.timestamp * 1000,
    block: l.block,
    tx: l.txHash,
    accountId: Number(l.account?.accountId ?? 0),
    market: l.market?.symbol ?? "?",
    side: (l.side === "SHORT" ? "short" : "long") as "long" | "short",
    price: l.market ? Number(l.liqPricePNS) / 10 ** l.market.priceDecimals : 0,
    notional: cns(l.notionalCNS),
    pnl: cns(l.pnlCNS) + cns(l.fundingCNS),
    address: l.account?.address ?? undefined,
  }));
  const recentFlows = d.CollateralFlow.map((f) => ({
    t: f.timestamp * 1000,
    block: f.block,
    tx: f.txHash,
    kind: (f.kind === "DEPOSIT" ? "deposit" : "withdrawal") as "deposit" | "withdrawal",
    accountId: Number(f.account?.accountId ?? 0),
    amount: cns(f.amountCNS),
    address: f.account?.address ?? undefined,
  }));
  const sum = (k: "deposits" | "withdrawals" | "liqNotional") => daily.reduce((a, x) => a + x[k], 0);
  return {
    days: null,
    from: daily[0]?.t ?? Date.now(),
    daily,
    totals: { deposits: sum("deposits"), withdrawals: sum("withdrawals"), liqCount: daily.reduce((a, x) => a + x.liqCount, 0), liqNotional: sum("liqNotional") },
    all: [] as (readonly [number, number, number, string])[], // per-wallet flows: indexerWalletFlows
    recentFlows,
    recentLiqs: liqs.slice(0, 40),
    liqsAll: liqs,
  };
}

/** Cumulative net deposits per day: TVL proxy over the full history (excludes trader PnL and fees). */
export async function indexerTvlCurve() {
  const d = await envioQuery<{ ProtocolDaily: { date: number; netFlowCNS: string }[] }>(
    `query($chain: Int!) { ProtocolDaily(where: { chainId: { _eq: $chain } }, order_by: { date: asc }) { date netFlowCNS } }`,
  );
  let cum = 0;
  return d.ProtocolDaily.map((r) => ({ t: r.date * 1000 + DAY - 1, tvl: (cum += cns(r.netFlowCNS)) }));
}
