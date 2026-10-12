import "server-only";
import { unstable_cache } from "next/cache";
import { createPublicClient } from "viem";
import { envioAll, envioQuery, indexerConfigured } from "../perpl/indexer";
import { perplExchangeAbi } from "../perpl/abi";
import { PERPL, copasChain, rpcTransport } from "../chains";
import { perpIdsForChain } from "./contracts";

/**
 * Copas rows from the Envio indexer (schema: copas/indexer/schema.graphql, entities are per chain).
 * Ids/addresses are lowercase. Every reader returns null when the indexer is not configured or
 * fails, so pages show an honest empty state instead of crashing.
 */
const CHAIN = copasChain.id;
const cns = (x: string | number) => Number(x) / 1e6;
export const BREACH_REASON = ["", "DRAWDOWN", "LEVERAGE", "NOTIONAL", "MARKET"];

/**
 * Every Copas indexer read goes through this 15 s shared cache, keyed by the request. The hosted dev indexer answers 429
 * once a few page renders (landing, seasons, proof each fire 6 to 10 queries) land at the same time. Failures are not cached.
 */
const cached = <T,>(key: unknown[], fn: () => Promise<T>) => unstable_cache(fn, ["copas-indexer", JSON.stringify(key)], { revalidate: 15 })();

async function q<T>(query: string, variables: Record<string, unknown> = {}): Promise<T | null> {
  if (!indexerConfigured()) return null;
  return cached([query, variables], () => envioQuery<T>(query, { ...variables, chain: CHAIN })).catch(() => null);
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

const client = createPublicClient({ chain: copasChain, transport: rpcTransport(copasChain) });

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

/* --------------------------------- protocol --------------------------------- */

/** Every row of a Copas entity on this chain (paged: the hosted Hasura caps at 1000 rows and has no _aggregate). */
const all = <T,>(entity: string, fields: string, where = "") =>
  cached([entity, fields, where], () => envioAll<T>(entity, `where: { chainId: { _eq: $chain }${where} }, order_by: { id: asc }`, fields, { chain: CHAIN }));

/** Lifetime counters for the landing strip. Null when the indexer is unavailable. */
export async function protocolMetrics() {
  if (!indexerConfigured()) return null;
  try {
    const [followers, fills, claims, vaults, checkpoints, epochs, breaches] = await Promise.all([
      all<{ id: string }>("Follower", "id", ", active: { _eq: true }"),
      all<{ id: string }>("CopyFill", "id"),
      all<{ amountCNS: string }>("Claim", "amountCNS"),
      all<{ id: string }>("Vault", "id"),
      all<{ id: string }>("Checkpoint", "id"),
      all<{ epoch: number }>("Epoch", "epoch", ", epoch: { _gt: 1 }"), // epoch 1 starts with the first deposit; later rows are rollEpoch calls
      all<{ leader_id: string }>("Breach", "leader_id"),
    ]);
    return {
      followers: followers.length,
      syncs: fills.length,
      slashPaid: claims.reduce((a, c) => a + cns(c.amountCNS), 0),
      claims: claims.length,
      vaults: vaults.length,
      upkeep: checkpoints.length + epochs.length + fills.length,
      // a slashed leader drops to Unbonded onchain, so count distinct leaders with a Breach row, not status == breached
      slashedLeaders: new Set(breaches.map((b) => b.leader_id)).size,
    };
  } catch {
    return null;
  }
}

/* ---------------------------------- seasons ---------------------------------- */

export const WEEK = 7 * 86_400;
/** Monday 00:00 UTC (unix seconds) of the week containing `t` (unix seconds). */
export const weekStart = (t: number) => Math.floor((t - 4 * 86_400) / WEEK) * WEEK + 4 * 86_400; // 1970-01-05 was a Monday

export type SeasonRow = {
  book: string; bond: number; followers: number; vaults: number;
  tradePnl: number; fees: number; perfFees: number; slashPaid: number; net: number; caps: number;
  breaches: number; unitStart: number | null; unitEnd: number | null; fills: number;
};

/**
 * Follower outcome per leader over [from, to) (unix seconds), from indexer rows only:
 *   net = Σ(follower vault fills: realizedPnl − fee) + Σ(slash claims paid to them) − Σ(performance fees of epochs ending in the window)
 * A vault fill is attributed to the leader of the CopyFill in the same tx (every vault trade is a sync), else the vault's current leader.
 */
export async function seasonBoard(from: number, to: number): Promise<{ rows: SeasonRow[]; firstAt: number } | null> {
  if (!indexerConfigured()) return null;
  const win = `, timestamp: { _gte: ${from}, _lt: ${to} }`;
  try {
    const [leaders, vaults, copies, claims, breaches, epochs, cps] = await Promise.all([
      all<{ id: string; bondCNS: string; createdAt: number }>("Leader", "id bondCNS createdAt"),
      all<{ id: string; perplAccount: { id: string } | null; currentLeader: { id: string } | null; follows: { leader_id: string; active: boolean; capCNS: string; followedAt: number }[] }>(
        "Vault", "id perplAccount { id } currentLeader { id } follows { leader_id active capCNS followedAt }"),
      all<{ txHash: string; leader_id: string | null }>("CopyFill", "txHash leader_id", win),
      all<{ amountCNS: string; breach: { leader_id: string } | null }>("Claim", "amountCNS breach { leader_id }", win),
      all<{ leader_id: string }>("Breach", "leader_id", win),
      all<{ leader_id: string; feesToLeaderCNS: string; feesToUnderwritersCNS: string }>("Epoch", "leader_id feesToLeaderCNS feesToUnderwritersCNS", `, end: { _gte: ${from}, _lt: ${to} }`),
      all<{ leader_id: string; unitPrice: string; timestamp: number }>("Checkpoint", "leader_id unitPrice timestamp", `, timestamp: { _lt: ${to} }`),
    ]);
    const accounts = vaults.flatMap((v) => (v.perplAccount ? [v.perplAccount.id] : []));
    const fills = accounts.length
      ? await cached(["Fill", accounts, from, to], () =>
          envioAll<{ account_id: string; realizedPnlCNS: string; feeCNS: string; txHash: string }>(
            "Fill",
            `where: { chainId: { _eq: $chain }, account_id: { _in: $acc }, timestamp: { _gte: ${from}, _lt: ${to} } }, order_by: { id: asc }`,
            "account_id realizedPnlCNS feeCNS txHash",
            { chain: CHAIN, acc: accounts },
            ", $acc: [String!]!",
          ),
        )
      : [];
    const txLeader = new Map(copies.filter((c) => c.leader_id).map((c) => [c.txHash, c.leader_id!]));
    const vaultOfAcct = new Map(vaults.flatMap((v) => (v.perplAccount ? [[v.perplAccount.id, v] as const] : [])));
    const row = new Map<string, SeasonRow>(
      leaders.map((l) => [l.id, { book: l.id, bond: cns(l.bondCNS), followers: 0, vaults: 0, tradePnl: 0, fees: 0, perfFees: 0, slashPaid: 0, net: 0, caps: 0, breaches: 0, unitStart: null, unitEnd: null, fills: 0 }]),
    );
    const traded = new Map<string, Set<string>>();
    for (const f of fills) {
      const v = vaultOfAcct.get(f.account_id);
      const r = row.get(txLeader.get(f.txHash) ?? v?.currentLeader?.id ?? "");
      if (!r || !v) continue;
      r.tradePnl += cns(f.realizedPnlCNS);
      r.fees += cns(f.feeCNS);
      r.fills++;
      (traded.get(r.book) ?? traded.set(r.book, new Set()).get(r.book)!).add(v.id);
    }
    for (const v of vaults)
      for (const f of v.follows) {
        const r = row.get(f.leader_id);
        if (!r || f.followedAt >= to) continue;
        if (f.active) { r.followers++; r.caps += cns(f.capCNS); }
      }
    for (const [book, s] of traded) row.get(book)!.vaults = s.size;
    for (const c of claims) { const r = row.get(c.breach?.leader_id ?? ""); if (r) r.slashPaid += cns(c.amountCNS); }
    for (const b of breaches) { const r = row.get(b.leader_id); if (r) r.breaches++; }
    for (const e of epochs) { const r = row.get(e.leader_id); if (r) r.perfFees += cns(e.feesToLeaderCNS) + cns(e.feesToUnderwritersCNS); }
    // unit price at the window edges: last checkpoint before `from` / before `to`; a LeaderBook's unit starts at 1.0
    const byLeader = new Map<string, { u: number; t: number }[]>();
    for (const c of cps) (byLeader.get(c.leader_id) ?? byLeader.set(c.leader_id, []).get(c.leader_id)!).push({ u: Number(c.unitPrice) / 1e18, t: c.timestamp });
    for (const l of leaders) {
      const r = row.get(l.id)!;
      const pts = (byLeader.get(l.id) ?? []).sort((a, b) => a.t - b.t);
      r.unitStart = pts.filter((p) => p.t < from).at(-1)?.u ?? 1;
      r.unitEnd = pts.at(-1)?.u ?? 1;
    }
    const live = new Set(leaders.filter((l) => l.createdAt < to).map((l) => l.id)); // leaders that existed in the window
    const rows = [...row.values()].filter((r) => live.has(r.book)).map((r) => ({ ...r, net: r.tradePnl - r.fees + r.slashPaid - r.perfFees }));
    return { rows, firstAt: Math.min(...leaders.map((l) => l.createdAt), Math.floor(Date.now() / 1000)) };
  } catch {
    return null;
  }
}
