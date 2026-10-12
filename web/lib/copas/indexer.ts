import "server-only";
import { createPublicClient, http } from "viem";
import { envioQuery, indexerConfigured } from "../perpl/indexer";
import { perplExchangeAbi } from "../perpl/abi";
import { PERPL, copasChain } from "../chains";
import { perpIdsForChain } from "./contracts";

/**
 * Copas rows from the Envio indexer (schema: copas/indexer/schema.graphql, entities are per chain).
 * Ids/addresses are lowercase. Every reader returns null when the indexer is not configured or
 * fails, so pages show an honest empty state instead of crashing.
 */
const CHAIN = copasChain.id;
const cns = (x: string | number) => Number(x) / 1e6;
export const BREACH_REASON = ["", "DRAWDOWN", "LEVERAGE", "NOTIONAL", "MARKET"];

async function q<T>(query: string, variables: Record<string, unknown> = {}): Promise<T | null> {
  if (!indexerConfigured()) return null;
  return envioQuery<T>(query, { ...variables, chain: CHAIN }).catch(() => null);
}

export type LiveCheckpoint = { epoch: number; t: number; unitPrice: number; ddPct: number; leverage: number; block: number; tx?: string; breach?: string };

/** Checkpoints of one LeaderBook, newest first, with the Breached tx folded into the checkpoint that tripped it. */
export async function leaderCheckpoints(book: string): Promise<LiveCheckpoint[] | null> {
  const d = await q<{
    Checkpoint: { epoch: number; unitPrice: string; ddBps: number; leverageHdths: number; timestamp: number; block: number }[];
    Breach: { epoch: number; reason: number; timestamp: number; txHash: string }[];
  }>(
    `query($chain: Int!, $l: String!) {
      Checkpoint(where: { chainId: { _eq: $chain }, leader_id: { _eq: $l } }, order_by: { timestamp: desc }, limit: 50) { epoch unitPrice ddBps leverageHdths timestamp block }
      Breach(where: { chainId: { _eq: $chain }, leader_id: { _eq: $l } }) { epoch reason timestamp txHash }
    }`,
    { l: book.toLowerCase() },
  );
  if (!d) return null;
  const rows: LiveCheckpoint[] = d.Checkpoint.map((c) => ({ epoch: c.epoch, t: c.timestamp * 1000, unitPrice: Number(c.unitPrice) / 1e18, ddPct: c.ddBps / 100, leverage: c.leverageHdths / 100, block: c.block }));
  for (const b of d.Breach) {
    const reason = BREACH_REASON[b.reason] ?? String(b.reason);
    // the checkpoint that breached sits in the same epoch at or before the Breached event
    const c = rows.find((r) => r.epoch === b.epoch && r.t <= b.timestamp * 1000);
    if (c) Object.assign(c, { breach: reason, tx: b.txHash });
    else rows.unshift({ epoch: b.epoch, t: b.timestamp * 1000, unitPrice: NaN, ddPct: NaN, leverage: NaN, block: 0, tx: b.txHash, breach: reason });
  }
  return rows;
}

/** Every breach on the Copas chain, newest first. Peak unit is implied from the breaching checkpoint's dd. */
export async function copasBreaches() {
  const d = await q<{
    Breach: {
      leader_id: string; epoch: number; reason: number; potCNS: string; capTotalCNS: string; timestamp: number; txHash: string;
      claims: { amountCNS: string; vault_id: string }[];
      leader: { checkpoints: { epoch: number; timestamp: number; unitPrice: string; ddBps: number }[] } | null;
    }[];
  }>(
    `query($chain: Int!) { Breach(where: { chainId: { _eq: $chain } }, order_by: { timestamp: desc }, limit: 50) {
      leader_id epoch reason potCNS capTotalCNS timestamp txHash claims { amountCNS vault_id }
      leader { checkpoints(order_by: { timestamp: desc }, limit: 100) { epoch timestamp unitPrice ddBps } } } }`,
  );
  return d?.Breach.map((b) => {
    const c = b.leader?.checkpoints.find((x) => x.epoch === b.epoch && x.timestamp <= b.timestamp);
    const unit = c ? Number(c.unitPrice) / 1e18 : NaN;
    const dd = c ? c.ddBps / 1e4 : NaN;
    return {
      book: b.leader_id,
      epoch: b.epoch,
      reason: BREACH_REASON[b.reason] ?? String(b.reason),
      unit,
      peak: unit / (1 - dd),
      ddPct: dd * 100,
      slash: cns(b.potCNS),
      capTotal: cns(b.capTotalCNS),
      claimed: b.claims.reduce((a, x) => a + cns(x.amountCNS), 0),
      claims: b.claims.map((x) => ({ vault: x.vault_id as `0x${string}`, amount: cns(x.amountCNS) })),
      t: b.timestamp * 1000,
      tx: b.txHash,
    };
  }) ?? null;
}

/** Per-leader rollups: active followers, breach count, fees paid to underwriters, pending underwriter withdrawals. */
export async function leaderStats() {
  const d = await q<{
    Leader: { id: string; followers: number; breaches: { epoch: number }[]; epochs: { feesToUnderwritersCNS: string }[] }[];
    UnderwriterPosition: { leader_id: string | null; pool: string; pendingShares: string }[];
  }>(
    `query($chain: Int!) {
      Leader(where: { chainId: { _eq: $chain } }) { id followers breaches { epoch } epochs { feesToUnderwritersCNS } }
      UnderwriterPosition(where: { chainId: { _eq: $chain }, pendingShares: { _gt: "0" } }) { leader_id pool pendingShares }
    }`,
  );
  if (!d) return null;
  return new Map(
    d.Leader.map((l) => [
      l.id,
      {
        followers: l.followers,
        breaches: l.breaches.length,
        uwFees: l.epochs.reduce((a, e) => a + cns(e.feesToUnderwritersCNS), 0),
        uwPendingShares: d.UnderwriterPosition.filter((u) => u.leader_id === l.id).reduce((a, u) => a + cns(u.pendingShares), 0),
      },
    ]),
  );
}

/* ----------------------------------- vault ----------------------------------- */

type VaultRow = {
  id: string; owner: string; depositsCNS: string; withdrawalsCNS: string; feesPaidCNS: string; slashReceivedCNS: string; paused: boolean;
  currentLeader: { id: string; mandateMaxDdBps: number | null; checkpoints: { ddBps: number }[] } | null;
  follows: {
    active: boolean; ratioBps: number; maxLeverageHdths: number; stopLossBps: number; capCNS: string; leader_id: string;
    leader: { breaches: { epoch: number; potCNS: string; capTotalCNS: string }[] } | null;
  }[];
  copyFills: { leaderLotLNS: string; fromLotLNS: string; targetLotLNS: string; markPricePNS: string; timestamp: number; block: number; txHash: string; market_id: string; market: { symbol: string; priceDecimals: number; lotDecimals: number } | null }[];
  claims: { amountCNS: string; timestamp: number; txHash: string; breach: { leader_id: string; epoch: number } | null }[];
};

const client = createPublicClient({ chain: copasChain, transport: http() });

/** Testnet Perpl markets are indexed without ContractAdded decimals, so read them from the exchange. */
async function perpDecimals(ids: string[]) {
  const res = await client
    .multicall({ contracts: ids.map((id) => ({ address: PERPL[copasChain.id].exchange, abi: perplExchangeAbi, functionName: "getPerpetualInfo", args: [BigInt(id)] }) as const) })
    .catch(() => []);
  return new Map(ids.map((id, i) => [id, res[i]?.status === "success" ? { pd: Number(res[i].result.priceDecimals), ld: Number(res[i].result.lotDecimals) } : null]));
}

/** The newest vault of an owner (or one vault by address), with follow params, copies and claims. */
export async function copasVault({ owner, vault }: { owner?: string; vault?: string }) {
  if (!owner && !vault) return null;
  const where = vault ? { id: { _eq: vault.toLowerCase() } } : { owner: { _eq: owner!.toLowerCase() } };
  const d = await q<{ Vault: VaultRow[] }>(
    `query($chain: Int!, $w: Vault_bool_exp!) { Vault(where: { _and: [{ chainId: { _eq: $chain } }, $w] }, order_by: { createdAt: desc }, limit: 1) {
      id owner depositsCNS withdrawalsCNS feesPaidCNS slashReceivedCNS paused
      currentLeader { id mandateMaxDdBps checkpoints(order_by: { timestamp: desc }, limit: 1) { ddBps } }
      follows { active ratioBps maxLeverageHdths stopLossBps capCNS leader_id leader { breaches { epoch potCNS capTotalCNS } } }
      copyFills(order_by: { timestamp: desc }, limit: 30) { leaderLotLNS fromLotLNS targetLotLNS markPricePNS timestamp block txHash market_id market { symbol priceDecimals lotDecimals } }
      claims(order_by: { timestamp: desc }) { amountCNS timestamp txHash breach { leader_id epoch } } } }`,
    { w: where },
  );
  const v = d?.Vault[0];
  if (!v) return null;
  const f = v.follows.find((x) => x.active) ?? v.follows[0];
  const names = Object.fromEntries(Object.entries(perpIdsForChain()).map(([k, id]) => [String(id), k]));
  const dec = await perpDecimals([...new Set(v.copyFills.map((c) => c.market_id))]);
  const claimed = new Set(v.claims.map((c) => `${c.breach?.leader_id}-${c.breach?.epoch}`));
  return {
    vault: v.id as `0x${string}`,
    owner: v.owner,
    leader: v.currentLeader?.id as `0x${string}` | undefined,
    leaderDD: (v.currentLeader?.checkpoints[0]?.ddBps ?? 0) / 100,
    leaderMaxDD: (v.currentLeader?.mandateMaxDdBps ?? 0) / 100,
    netDeposit: cns(v.depositsCNS) - cns(v.withdrawalsCNS),
    feesPaid: cns(v.feesPaidCNS),
    slashReceived: cns(v.slashReceivedCNS),
    paused: v.paused,
    params: f ? { ratioPct: f.ratioBps / 100, maxLeverage: f.maxLeverageHdths / 100, stopLossPct: f.stopLossBps / 100 } : null,
    // breaches of followed leaders this vault has not claimed yet; estimate before min(·, actual loss)
    claimable: v.follows.flatMap((x) =>
      (x.leader?.breaches ?? [])
        .filter((b) => !claimed.has(`${x.leader_id}-${b.epoch}`))
        .map((b) => ({ book: x.leader_id as `0x${string}`, epoch: b.epoch, estimate: Number(b.capTotalCNS) ? (cns(b.potCNS) * cns(x.capCNS)) / cns(b.capTotalCNS) : 0 })),
    ),
    claims: v.claims.map((c) => ({ book: c.breach?.leader_id ?? "", epoch: c.breach?.epoch ?? 0, amount: cns(c.amountCNS), t: c.timestamp * 1000, tx: c.txHash })),
    fills: v.copyFills.map((c) => {
      const dd = dec.get(c.market_id) ?? (c.market?.priceDecimals ? { pd: c.market.priceDecimals, ld: c.market.lotDecimals } : { pd: 0, ld: 0 });
      const lot = (x: string) => Number(x) / 10 ** dd.ld;
      return {
        t: c.timestamp * 1000,
        market: names[c.market_id] ?? c.market?.symbol ?? c.market_id,
        leaderLot: lot(c.leaderLotLNS),
        from: lot(c.fromLotLNS),
        target: lot(c.targetLotLNS),
        mark: Number(c.markPricePNS) / 10 ** dd.pd,
        block: c.block,
        tx: c.txHash,
      };
    }),
  };
}
export type LiveVault = NonNullable<Awaited<ReturnType<typeof copasVault>>>;
