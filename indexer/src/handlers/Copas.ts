// Copas contracts: CopasRegistry (factory) -> LeaderBook / UnderwriterPool / FollowerVault (dynamic),
// plus BreachMarket and AgentLeaderRegistry. All addresses stored lowercase.
import { indexer, type Leader, type Vault, type Follower } from "envio";
import type { Ctx } from "../perpl.js";

const F = { transaction: ["hash"], block: ["timestamp"] } as const;
const lc = (a: string) => a.toLowerCase();
const STATUS = ["Active", "Unbonded", "Breached"] as const satisfies readonly Leader["status"][];
type Ev = { block: { number: number; timestamp: number }; logIndex: number };
const evId = (e: Ev) => `${e.block.number}-${e.logIndex}`;

// ---------------------------------------------------------------------------
// Registry (factory)
// ---------------------------------------------------------------------------

indexer.contractRegister({ contract: "CopasRegistry", event: "LeaderCreated" }, async ({ event, context }) => {
  context.chain.LeaderBook.add(event.params.leaderBook);
  context.chain.UnderwriterPool.add(event.params.pool);
});

indexer.contractRegister({ contract: "CopasRegistry", event: "VaultCreated" }, async ({ event, context }) => {
  context.chain.FollowerVault.add(event.params.vault);
});

indexer.onEvent({ contract: "CopasRegistry", event: "LeaderCreated", fields: F }, async ({ event: e, context }) => {
  context.Leader.set({
    id: lc(e.params.leaderBook), owner: lc(e.params.owner), underwriterPool: lc(e.params.pool), perplAccount_id: undefined,
    status: "Active", bondCNS: 0n, unbondUnlockEpoch: undefined, unitPrice: 0n, equityCNS: 0n, peakEquityCNS: 0n,
    maxDrawdownBps: 0, mandateMaxDdBps: undefined, mandateMaxLeverageHdths: undefined, mandateFeeBps: undefined,
    mandateEpochLen: undefined, mandateMaxNotionalCNS: undefined, mandateMarketsMask: undefined,
    mandateEffectiveEpoch: undefined, currentEpoch: 0, followers: 0, aumCNS: 0n, totalSlashedCNS: 0n,
    agentId: undefined, agentWallet: undefined, createdAt: e.block.timestamp,
  });
});

indexer.onEvent({ contract: "CopasRegistry", event: "VaultCreated", fields: F }, async ({ event: e, context }) => {
  context.Vault.set({
    id: lc(e.params.vault), owner: lc(e.params.owner), perplAccount_id: undefined, currentLeader_id: undefined,
    depositsCNS: 0n, withdrawalsCNS: 0n, feesPaidCNS: 0n, slashReceivedCNS: 0n, paused: false, createdAt: e.block.timestamp,
  });
});

// ---------------------------------------------------------------------------
// LeaderBook
// ---------------------------------------------------------------------------

/** Load the leader of the emitting LeaderBook, apply `fn`, save. */
async function withLeader(ctx: Ctx, srcAddress: string, fn: (l: Leader) => Partial<Leader>) {
  const l = await ctx.Leader.get(lc(srcAddress));
  if (!l) return;
  ctx.Leader.set({ ...l, ...fn(l) });
}

indexer.onEvent({ contract: "LeaderBook", event: "BondPosted", fields: F }, async ({ event: e, context }) =>
  withLeader(context, e.srcAddress, () => ({ bondCNS: e.params.bond })));

indexer.onEvent({ contract: "LeaderBook", event: "UnbondRequested", fields: F }, async ({ event: e, context }) =>
  withLeader(context, e.srcAddress, () => ({ unbondUnlockEpoch: Number(e.params.unlockEpoch) })));

indexer.onEvent({ contract: "LeaderBook", event: "Unbonded", fields: F }, async ({ event: e, context }) =>
  withLeader(context, e.srcAddress, (l) => {
    const bondCNS = l.bondCNS > e.params.amount ? l.bondCNS - e.params.amount : 0n;
    return { bondCNS, unbondUnlockEpoch: undefined, status: bondCNS === 0n ? "Unbonded" : l.status };
  }));

indexer.onEvent({ contract: "LeaderBook", event: "MandateDeclared", fields: F }, async ({ event: e, context }) =>
  withLeader(context, e.srcAddress, () => ({
    mandateMaxDdBps: Number(e.params.m.maxDDbps), mandateMaxLeverageHdths: Number(e.params.m.maxLeverageHdths),
    mandateFeeBps: Number(e.params.m.feeBps), mandateEpochLen: e.params.m.epochLen,
    mandateMaxNotionalCNS: e.params.m.maxNotionalCNS, mandateMarketsMask: e.params.m.marketsMask,
    mandateEffectiveEpoch: Number(e.params.effectiveEpoch),
  })));

indexer.onEvent({ contract: "LeaderBook", event: "Deposited", fields: F }, async ({ event: e, context }) =>
  withLeader(context, e.srcAddress, (l) => ({ aumCNS: l.aumCNS + e.params.amount, unitPrice: e.params.unitPrice })));

indexer.onEvent({ contract: "LeaderBook", event: "Withdrawn", fields: F }, async ({ event: e, context }) =>
  withLeader(context, e.srcAddress, (l) => ({ aumCNS: l.aumCNS > e.params.amount ? l.aumCNS - e.params.amount : 0n })));

indexer.onEvent({ contract: "LeaderBook", event: "Checkpoint", fields: F }, async ({ event: e, context }) => {
  const leader = lc(e.srcAddress);
  context.Checkpoint.set({
    id: evId(e), leader_id: leader, epoch: Number(e.params.epoch), equityCNS: e.params.equity,
    unitPrice: e.params.unitPrice, peakCNS: e.params.peak, ddBps: Number(e.params.ddBps),
    leverageHdths: Number(e.params.leverageHdths), timestamp: e.block.timestamp, block: e.block.number,
  });
  await withLeader(context, leader, (l) => ({
    equityCNS: e.params.equity, unitPrice: e.params.unitPrice, peakEquityCNS: e.params.peak,
    maxDrawdownBps: Math.max(l.maxDrawdownBps, Number(e.params.ddBps)), currentEpoch: Number(e.params.epoch),
  }));
});

indexer.onEvent({ contract: "LeaderBook", event: "Breached", fields: F }, async ({ event: e, context }) => {
  const leader = lc(e.srcAddress), epoch = Number(e.params.epoch);
  context.Breach.set({
    id: `${leader}-${epoch}`, leader_id: leader, epoch, reason: Number(e.params.reason), potCNS: e.params.pot,
    capTotalCNS: e.params.capTotal, claimedCNS: 0n, timestamp: e.block.timestamp, txHash: e.transaction.hash,
  });
  const ep = await context.Epoch.get(`${leader}-${epoch}`);
  if (ep) context.Epoch.set({ ...ep, breached: true, status: "Breached" });
  await withLeader(context, leader, (l) => ({ status: "Breached", totalSlashedCNS: l.totalSlashedCNS + e.params.pot }));
});

indexer.onEvent({ contract: "LeaderBook", event: "EpochRolled", fields: F }, async ({ event: e, context }) => {
  const leader = lc(e.srcAddress), epoch = Number(e.params.epoch);
  const status = STATUS[Number(e.params.status)] ?? "Active";
  context.Epoch.set({
    id: `${leader}-${epoch}`, leader_id: leader, epoch, start: Number(e.params.start), end: Number(e.params.end),
    startUnitPrice: e.params.unitPrice, status, breached: status === "Breached",
    feesToLeaderCNS: 0n, feesToUnderwritersCNS: 0n,
  });
  await withLeader(context, leader, () => ({ currentEpoch: epoch, status, unitPrice: e.params.unitPrice }));
});

async function upsertFollower(ctx: Ctx, vault: string, leader: string, ts: number, patch: Partial<Follower>) {
  const id = `${vault}-${leader}`;
  const f = (await ctx.Follower.get(id)) ?? {
    id, vault_id: vault, leader_id: leader, active: false, ratioBps: 0, maxLeverageHdths: 0, maxChaseBps: 0,
    priceBandBps: 0, stopLossBps: 0, maxNotionalCNS: 0n, capCNS: 0n, fromEpoch: undefined, untilEpoch: undefined,
    feesPaidCNS: 0n, followedAt: ts,
  };
  ctx.Follower.set({ ...f, ...patch });
}

indexer.onEvent({ contract: "LeaderBook", event: "FollowerRegistered", fields: F }, async ({ event: e, context }) => {
  const leader = lc(e.srcAddress);
  await upsertFollower(context, lc(e.params.vault), leader, e.block.timestamp, {
    active: true, capCNS: e.params.cap, fromEpoch: Number(e.params.fromEpoch), untilEpoch: undefined,
  });
  await withLeader(context, leader, (l) => ({ followers: l.followers + 1 }));
});

indexer.onEvent({ contract: "LeaderBook", event: "FollowerUnregistered", fields: F }, async ({ event: e, context }) => {
  const leader = lc(e.srcAddress);
  await upsertFollower(context, lc(e.params.vault), leader, e.block.timestamp, {
    active: false, untilEpoch: Number(e.params.untilEpoch),
  });
  await withLeader(context, leader, (l) => ({ followers: Math.max(l.followers - 1, 0) }));
});

indexer.onEvent({ contract: "LeaderBook", event: "Claimed", fields: F }, async ({ event: e, context }) => {
  const breachId = `${lc(e.srcAddress)}-${Number(e.params.epoch)}`;
  context.Claim.set({
    id: evId(e), breach_id: breachId, vault_id: lc(e.params.vault), to: lc(e.params.to), amountCNS: e.params.amount,
    timestamp: e.block.timestamp, txHash: e.transaction.hash,
  });
  const b = await context.Breach.get(breachId);
  if (b) context.Breach.set({ ...b, claimedCNS: b.claimedCNS + e.params.amount });
});

indexer.onEvent({ contract: "LeaderBook", event: "FeeDeposited", fields: F }, async ({ event: e, context }) => {
  const f = await context.Follower.get(`${lc(e.params.vault)}-${lc(e.srcAddress)}`);
  if (f) context.Follower.set({ ...f, feesPaidCNS: f.feesPaidCNS + e.params.amount });
});

indexer.onEvent({ contract: "LeaderBook", event: "FeesReleased", fields: F }, async ({ event: e, context }) => {
  const ep = await context.Epoch.get(`${lc(e.srcAddress)}-${Number(e.params.epoch)}`);
  if (ep) context.Epoch.set({
    ...ep, feesToLeaderCNS: ep.feesToLeaderCNS + e.params.toLeader,
    feesToUnderwritersCNS: ep.feesToUnderwritersCNS + e.params.toUnderwriters,
  });
});

// ---------------------------------------------------------------------------
// FollowerVault
// ---------------------------------------------------------------------------

async function withVault(ctx: Ctx, srcAddress: string, fn: (v: Vault) => Partial<Vault>) {
  const v = await ctx.Vault.get(lc(srcAddress));
  if (!v) return;
  ctx.Vault.set({ ...v, ...fn(v) });
}

indexer.onEvent({ contract: "FollowerVault", event: "Deposited", fields: F }, async ({ event: e, context }) =>
  withVault(context, e.srcAddress, (v) => ({ depositsCNS: v.depositsCNS + e.params.amount })));

indexer.onEvent({ contract: "FollowerVault", event: "Withdrawn", fields: F }, async ({ event: e, context }) =>
  withVault(context, e.srcAddress, (v) => ({ withdrawalsCNS: v.withdrawalsCNS + e.params.amount })));

indexer.onEvent({ contract: "FollowerVault", event: "Followed", fields: F }, async ({ event: e, context }) => {
  const vault = lc(e.srcAddress), leader = lc(e.params.leader), p = e.params.p;
  await upsertFollower(context, vault, leader, e.block.timestamp, {
    active: true, ratioBps: Number(p.ratioBps), maxLeverageHdths: Number(p.maxLeverageHdths),
    maxChaseBps: Number(p.maxChaseBps), priceBandBps: Number(p.priceBandBps), stopLossBps: Number(p.stopLossBps),
    maxNotionalCNS: p.maxNotionalCNS, followedAt: e.block.timestamp,
  });
  await withVault(context, vault, () => ({ currentLeader_id: leader, paused: false }));
});

indexer.onEvent({ contract: "FollowerVault", event: "Unfollowed", fields: F }, async ({ event: e, context }) => {
  const vault = lc(e.srcAddress);
  await upsertFollower(context, vault, lc(e.params.leader), e.block.timestamp, { active: false });
  await withVault(context, vault, () => ({ currentLeader_id: undefined }));
});

indexer.onEvent({ contract: "FollowerVault", event: "Synced", fields: F }, async ({ event: e, context }) => {
  const v = await context.Vault.get(lc(e.srcAddress));
  if (!v) return;
  context.CopyFill.set({
    id: evId(e), vault_id: v.id, leader_id: v.currentLeader_id, market_id: e.params.perpId.toString(),
    leaderLotLNS: e.params.leaderLot, fromLotLNS: e.params.fromLot, targetLotLNS: e.params.targetLot,
    markPricePNS: e.params.mark, timestamp: e.block.timestamp, block: e.block.number, txHash: e.transaction.hash,
  });
});

indexer.onEvent({ contract: "FollowerVault", event: "StopLoss", fields: F }, async ({ event: e, context }) =>
  withVault(context, e.srcAddress, () => ({ paused: true })));

indexer.onEvent({ contract: "FollowerVault", event: "ClaimedSlash", fields: F }, async ({ event: e, context }) =>
  withVault(context, e.srcAddress, (v) => ({ slashReceivedCNS: v.slashReceivedCNS + e.params.amount })));

// ---------------------------------------------------------------------------
// UnderwriterPool (one per leader)
// ---------------------------------------------------------------------------

async function withUnderwriter(ctx: Ctx, pool: string, who: string, fn: (u: Parameters<Ctx["UnderwriterPosition"]["set"]>[0]) => object) {
  const id = `${lc(pool)}-${lc(who)}`;
  let u = await ctx.UnderwriterPosition.get(id);
  if (!u) {
    const [leader] = await ctx.Leader.getWhere({ underwriterPool: { _eq: lc(pool) } });
    u = { id, pool: lc(pool), leader_id: leader?.id, who: lc(who), shares: 0n, depositedCNS: 0n, withdrawnCNS: 0n,
      pendingShares: 0n, unlockEpoch: undefined };
  }
  ctx.UnderwriterPosition.set({ ...u, ...fn(u) });
}

indexer.onEvent({ contract: "UnderwriterPool", event: "Deposited", fields: F }, async ({ event: e, context }) =>
  withUnderwriter(context, e.srcAddress, e.params.who, (u) => ({
    shares: u.shares + e.params.shares, depositedCNS: u.depositedCNS + e.params.amount,
  })));

indexer.onEvent({ contract: "UnderwriterPool", event: "WithdrawRequested", fields: F }, async ({ event: e, context }) =>
  withUnderwriter(context, e.srcAddress, e.params.who, (u) => ({
    pendingShares: u.pendingShares + e.params.shares, unlockEpoch: Number(e.params.unlockEpoch),
  })));

indexer.onEvent({ contract: "UnderwriterPool", event: "Withdrawn", fields: F }, async ({ event: e, context }) =>
  withUnderwriter(context, e.srcAddress, e.params.who, (u) => ({
    shares: u.shares > e.params.shares ? u.shares - e.params.shares : 0n,
    pendingShares: u.pendingShares > e.params.shares ? u.pendingShares - e.params.shares : 0n,
    withdrawnCNS: u.withdrawnCNS + e.params.amount,
  })));

// ---------------------------------------------------------------------------
// BreachMarket & AgentLeaderRegistry
// ---------------------------------------------------------------------------

const seriesId = (leaderBook: string, epoch: bigint) => `${lc(leaderBook)}-${epoch}`;

indexer.onEvent({ contract: "BreachMarket", event: "SeriesCreated", fields: F }, async ({ event: e, context }) => {
  context.BreachSeries.set({
    id: seriesId(e.params.leaderBook, e.params.epoch), leader: lc(e.params.leaderBook), epoch: Number(e.params.epoch),
    up: lc(e.params.up), down: lc(e.params.down), mintedCNS: 0n, redeemedCNS: 0n, settled: false, breach: undefined,
    createdAt: e.block.timestamp,
  });
});

for (const [event, field] of [["Minted", "mintedCNS"], ["PairRedeemed", "redeemedCNS"], ["Redeemed", "redeemedCNS"]] as const)
  indexer.onEvent({ contract: "BreachMarket", event, fields: F }, async ({ event: e, context }) => {
    const s = await context.BreachSeries.get(seriesId(e.params.leaderBook, e.params.epoch));
    if (s) context.BreachSeries.set({ ...s, [field]: s[field] + e.params.amount });
  });

indexer.onEvent({ contract: "BreachMarket", event: "Settled", fields: F }, async ({ event: e, context }) => {
  const s = await context.BreachSeries.get(seriesId(e.params.leaderBook, e.params.epoch));
  if (s) context.BreachSeries.set({ ...s, settled: true, breach: e.params.breach });
});

indexer.onEvent({ contract: "AgentLeaderRegistry", event: "AgentLinked", fields: F }, async ({ event: e, context }) =>
  withLeader(context, e.params.leaderBook, () => ({ agentId: e.params.agentId, agentWallet: lc(e.params.agentWallet) })));

indexer.onEvent({ contract: "AgentLeaderRegistry", event: "AgentUnlinked", fields: F }, async ({ event: e, context }) =>
  withLeader(context, e.params.leaderBook, () => ({ agentId: undefined, agentWallet: undefined })));
