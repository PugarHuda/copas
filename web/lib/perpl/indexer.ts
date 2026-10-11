import "server-only";
import type { Market } from "./api";
import type { Trade } from "./stats";

/**
 * Envio HyperIndex adapter (copas/indexer). When NEXT_PUBLIC_ENVIO_GRAPHQL_URL
 * is set, wallet history comes from the indexer (full history) instead of the
 * windowed RPC scan in lib/perpl/logs.ts.
 *
 * TODO(indexer): the query below assumes a `PerplTrade` entity
 *   { accountId, perpId, side, openedAt, closedAt, entryPrice, exitPrice, maxNotional, realizedPnl, liquidated, txHash }
 * with timestamps in seconds and amounts already scaled to AUSD / price units.
 * Align field names with copas/indexer/schema.graphql once it lands.
 */
export const indexerUrl = () => process.env.NEXT_PUBLIC_ENVIO_GRAPHQL_URL || "";
export const indexerConfigured = () => !!indexerUrl();

export async function envioQuery<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(indexerUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    next: { revalidate: 30 },
  });
  const j = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || j.errors?.length) throw new Error(j.errors?.[0]?.message ?? `envio ${res.status}`);
  return j.data as T;
}

type Row = {
  perpId: number;
  side: string;
  openedAt: number | null;
  closedAt: number;
  entryPrice: number | null;
  exitPrice: number | null;
  maxNotional: number;
  realizedPnl: number;
  liquidated: boolean;
  txHash: string;
};

export async function indexerWalletTrades(accountId: number, markets: Market[]): Promise<Trade[]> {
  const names = new Map(markets.map((m) => [m.id, m.name]));
  const d = await envioQuery<{ PerplTrade: Row[] }>(
    `query($acc: numeric!) { PerplTrade(where: { accountId: { _eq: $acc } }, order_by: { closedAt: desc }, limit: 2000) {
      perpId side openedAt closedAt entryPrice exitPrice maxNotional realizedPnl liquidated txHash } }`,
    { acc: accountId },
  );
  return d.PerplTrade.map((r) => ({
    market: names.get(Number(r.perpId)) ?? `#${r.perpId}`,
    side: r.side === "short" ? "short" : "long",
    openedAt: r.openedAt ? r.openedAt * 1000 : null,
    closedAt: r.closedAt * 1000,
    entry: r.entryPrice,
    exit: r.exitPrice,
    maxNotional: r.maxNotional,
    pnl: r.realizedPnl,
    liquidated: r.liquidated,
    tx: r.txHash,
  }));
}
