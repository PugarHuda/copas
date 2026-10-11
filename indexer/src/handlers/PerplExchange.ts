// Perpl Exchange handlers (Envio v3).
//
// Event order inside a Perpl match (verified on mainnet txs):
//   OrderRequestV2(taker) -> [maker Position* -> MakerOrderFilledV2]* -> taker Position* -> TakerOrderFilledV2
// Fills carry no link to their position event and TakerOrderFilled has no perpId/accountId,
// so a single rolling TxCursor row remembers the last position event of the current tx.
import { indexer, type Fill, type ClosedTrade, type CollateralFlow } from "envio";
import {
  type Ctx, max, notional,
  loadMarket, loadAccount, loadProtocol, loadProtocolDaily, loadMarketDaily, loadAccountDaily,
  loadPosition, loadCursor, applyPnl, refreshOI, markPrice, finalizeClosedTrade,
} from "../perpl.js";

type Side = NonNullable<Fill["side"]>;
type PositionSide = ClosedTrade["side"];
type CloseReason = ClosedTrade["reason"];
type FlowKind = CollateralFlow["kind"];

const F = { transaction: ["hash"], block: ["timestamp"] } as const;
type Ev = { block: { number: number; timestamp: number }; transaction: { hash: string }; logIndex: number };
const evId = (e: Ev) => `${e.block.number}-${e.logIndex}`;
const flip = (s: Side | undefined): Side | undefined => (s === "BUY" ? "SELL" : s === "SELL" ? "BUY" : undefined);

/** Finalize a closed trade still waiting for a closing fill that never came. */
async function flushPending(ctx: Ctx, tx: string) {
  const c = await loadCursor(ctx, tx);
  if (c.pendingClosedTrade) {
    await finalizeClosedTrade(ctx, c.pendingClosedTrade);
    c.pendingClosedTrade = undefined;
  }
  return c;
}

// ---------------------------------------------------------------------------
// Position lifecycle
// ---------------------------------------------------------------------------

type Kind = "OPEN" | "INCREASE" | "DECREASE" | "CLOSE" | "INVERT" | "LIQUIDATE" | "DELEVERAGE" | "UNWIND";
const REDUCES: Kind[] = ["DECREASE", "CLOSE", "LIQUIDATE", "DELEVERAGE", "UNWIND"];
const REASON: Partial<Record<Kind, CloseReason>> = {
  DECREASE: "CLOSED", CLOSE: "CLOSED", LIQUIDATE: "LIQUIDATED", DELEVERAGE: "DELEVERAGED", UNWIND: "UNWOUND",
};

type PosInput = {
  kind: Kind;
  perpId: bigint;
  accountId: bigint;
  positionType: bigint; // 0 long, 1 short (new side for inversions)
  lot?: bigint; // lot after the event; undefined = derive (liquidation)
  liqLot?: bigint;
  entryPrice?: bigint;
  exitPrice?: bigint;
  deposit?: bigint;
  leverage?: bigint;
  pnl: bigint; // price pnl realized
  funding: bigint; // funding realized
  insFee?: bigint;
  protFee?: bigint;
  liquidation?: { markPrice: bigint; liqPrice: bigint; posLot: bigint; onOrderBook: boolean };
};

async function onPosition(ctx: Ctx, e: Ev, p: PosInput) {
  const ts = e.block.timestamp, block = e.block.number, tx = e.transaction.hash;
  const cursor = await flushPending(ctx, tx); // before loading Account: finalize writes it
  const m = await loadMarket(ctx, p.perpId, ts);
  const a = await loadAccount(ctx, p.accountId, ts, block);
  let pos = await loadPosition(ctx, a, m, ts, block, tx);
  const proto = await loadProtocol(ctx, ts);
  const pd = await loadProtocolDaily(ctx, ts);
  const md = await loadMarketDaily(ctx, m, ts);
  const [ad] = await loadAccountDaily(ctx, a, ts);

  const side: PositionSide = p.positionType === 0n ? "LONG" : "SHORT";
  const reduces = REDUCES.includes(p.kind);
  const fillSide: Side = (side === "LONG") !== reduces ? "BUY" : "SELL";
  const realized = p.pnl + p.funding;
  const wasOpen = pos.isOpen;
  const oldLot = wasOpen ? pos.lotLNS : 0n;
  const oldSide = pos.side;
  let pending: string | undefined;

  const closeTrade = (reason: CloseReason, exitPrice: bigint) => {
    if (pos.tradeSeq === 0) return; // opened before start block: no round trip to report
    const id = `${pos.id}-${pos.tradeSeq}`;
    ctx.ClosedTrade.set({
      id, account_id: a.id, market_id: m.id, side: pos.side ?? side, reason,
      entryPricePNS: pos.entryPricePNS, exitPricePNS: exitPrice, maxLotLNS: pos.maxLotLNS,
      maxNotionalCNS: notional(m, pos.entryPricePNS, pos.maxLotLNS), leverageHdths: pos.leverageHdths,
      pnlCNS: pos.realizedPnlCNS, fundingCNS: pos.fundingCNS, feesCNS: pos.feesCNS,
      netPnlCNS: pos.realizedPnlCNS - pos.feesCNS, isWin: pos.realizedPnlCNS - pos.feesCNS > 0n,
      openedAt: pos.openedAt, closedAt: ts, holdSeconds: ts - pos.openedAt,
      openTx: pos.openTx, closeTx: tx, closeBlock: block,
    });
    pos.lastClosedTrade_id = id;
    pending = id;
  };
  const openTrade = () => {
    pos = {
      ...pos, isOpen: true, side, tradeSeq: pos.tradeSeq + 1, maxLotLNS: 0n, realizedPnlCNS: 0n,
      fundingCNS: 0n, feesCNS: 0n, openedAt: ts, openedBlock: block, openTx: tx,
    };
  };

  if (p.kind === "INVERT") {
    pos.realizedPnlCNS += realized;
    pos.fundingCNS += p.funding;
    closeTrade("INVERTED", p.entryPrice ?? 0n);
    openTrade();
  } else {
    if (p.kind === "OPEN" || (p.kind === "INCREASE" && !wasOpen)) openTrade();
    pos.realizedPnlCNS += realized;
    pos.fundingCNS += p.funding;
  }

  const newLot = p.lot ?? max(oldLot - (p.liqLot ?? 0n), 0n);
  pos.lotLNS = newLot;
  pos.maxLotLNS = max(pos.maxLotLNS, newLot);
  pos.entryPricePNS = p.entryPrice ?? pos.entryPricePNS;
  pos.depositCNS = p.deposit ?? (newLot === 0n ? 0n : pos.depositCNS);
  pos.leverageHdths = p.leverage ?? pos.leverageHdths;
  pos.side = side;
  pos.updatedAt = ts;
  if (reduces && newLot === 0n) {
    closeTrade(REASON[p.kind]!, p.exitPrice ?? 0n);
    pos.isOpen = false;
  }

  // open interest
  if (oldSide === "LONG") m.longOpenInterestLNS = max(m.longOpenInterestLNS - oldLot, 0n);
  if (oldSide === "SHORT") m.shortOpenInterestLNS = max(m.shortOpenInterestLNS - oldLot, 0n);
  if (pos.isOpen && side === "LONG") m.longOpenInterestLNS += newLot;
  if (pos.isOpen && side === "SHORT") m.shortOpenInterestLNS += newLot;
  proto.openInterestCNS += refreshOI(m, pos.entryPricePNS);
  m.lastUpdatedAt = ts;

  // account / protocol pnl
  applyPnl(a, realized, 0n);
  a.fundingPnlCNS += p.funding;
  a.openPositions += (pos.isOpen ? 1 : 0) - (wasOpen ? 1 : 0);
  proto.realizedPnlCNS += realized;
  proto.insFeesCNS += p.insFee ?? 0n;
  proto.protFeesCNS += p.protFee ?? 0n;
  pd.realizedPnlCNS += realized;
  ad.realizedPnlCNS += realized;
  ad.netPnlCNS += realized;
  ad.cumNetPnlCNS = a.netPnlCNS;

  if (p.liquidation) {
    const liqNotional = notional(m, p.liquidation.markPrice, p.liqLot ?? 0n);
    ctx.Liquidation.set({
      id: evId(e), account_id: a.id, market_id: m.id, kind: REASON[p.kind]!, side: oldSide ?? side,
      markPricePNS: p.liquidation.markPrice, liqPricePNS: p.liquidation.liqPrice, liqLotLNS: p.liqLot ?? 0n,
      posLotLNS: p.liquidation.posLot, notionalCNS: liqNotional, pnlCNS: p.pnl, fundingCNS: p.funding,
      onOrderBook: p.liquidation.onOrderBook, timestamp: ts, block, txHash: tx,
    });
    a.liquidations += 1;
    m.liquidations += 1;
    proto.liquidations += 1;
    proto.liquidatedNotionalCNS += liqNotional;
    pd.liquidations += 1;
    pd.liquidatedNotionalCNS += liqNotional;
    md.liquidations += 1;
    md.liquidatedNotionalCNS += liqNotional;
  }

  md.longOpenInterestLNS = m.longOpenInterestLNS;
  md.shortOpenInterestLNS = m.shortOpenInterestLNS;
  md.openInterestCNS = m.openInterestCNS;
  pd.openInterestCNS = proto.openInterestCNS;

  ctx.Position.set(pos);
  ctx.Market.set(m);
  ctx.Account.set(a);
  ctx.Protocol.set(proto);
  ctx.ProtocolDaily.set(pd);
  ctx.MarketDaily.set(md);
  ctx.AccountDaily.set(ad);
  // forced closes have no closing fill of their own: book the round trip now
  if (pending && (p.kind === "LIQUIDATE" || p.kind === "DELEVERAGE" || p.kind === "UNWIND")) {
    await finalizeClosedTrade(ctx, pending);
    pending = undefined;
  }
  ctx.TxCursor.set({
    ...cursor, accountId: a.id, perpId: m.id, side: fillSide, realizedPnlCNS: realized, pendingClosedTrade: pending,
  });
}

for (const name of ["PositionOpened", "PositionOpenedV2"] as const)
  indexer.onEvent({ contract: "PerplExchange", event: name, fields: F }, ({ event: e, context: ctx }) => onPosition(ctx, e, {
    kind: "OPEN", perpId: e.params.perpId, accountId: e.params.accountId, positionType: e.params.positionType,
    lot: e.params.lotLNS, entryPrice: e.params.pricePNS, deposit: e.params.depositCNS,
    leverage: e.params.leverageHdths, pnl: 0n, funding: 0n, insFee: e.params.insFeeCNS, protFee: e.params.protFeeCNS,
  }));

for (const name of ["PositionIncreased", "PositionIncreasedV2"] as const)
  indexer.onEvent({ contract: "PerplExchange", event: name, fields: F }, ({ event: e, context: ctx }) => onPosition(ctx, e, {
    kind: "INCREASE", perpId: e.params.perpId, accountId: e.params.accountId, positionType: e.params.positionType,
    lot: e.params.endLotLNS, entryPrice: e.params.pricePNS, deposit: e.params.endDepositCNS,
    leverage: e.params.leverageHdths, pnl: 0n, funding: e.params.premiumPnlSettledCNS,
    insFee: e.params.insFeeCNS, protFee: e.params.protFeeCNS,
  }));

indexer.onEvent({ contract: "PerplExchange", event: "PositionDecreased", fields: F }, ({ event: e, context: ctx }) => onPosition(ctx, e, {
  kind: "DECREASE", perpId: e.params.perpId, accountId: e.params.accountId, positionType: e.params.positionType,
  lot: e.params.endLotLNS, deposit: e.params.endDepositCNS, pnl: e.params.deltaPnlCNS, funding: e.params.fundingCNS,
}));

indexer.onEvent({ contract: "PerplExchange", event: "PositionClosed", fields: F }, ({ event: e, context: ctx }) => onPosition(ctx, e, {
  kind: "CLOSE", perpId: e.params.perpId, accountId: e.params.accountId, positionType: e.params.positionType,
  lot: 0n, exitPrice: e.params.pricePNS, pnl: e.params.deltaPnlCNS, funding: e.params.fundingCNS,
}));

indexer.onEvent({ contract: "PerplExchange", event: "PositionInverted", fields: F }, ({ event: e, context: ctx }) => onPosition(ctx, e, {
  kind: "INVERT", perpId: e.params.perpId, accountId: e.params.accountId, positionType: e.params.positionType,
  lot: e.params.endLotLNS, entryPrice: e.params.pricePNS, deposit: e.params.endDepositCNS,
  leverage: e.params.leverageHdths, pnl: e.params.deltaPnlCNS, funding: e.params.fundingCNS,
  insFee: e.params.insFeeCNS, protFee: e.params.protFeeCNS,
}));

indexer.onEvent({ contract: "PerplExchange", event: "PositionLiquidated", fields: F }, ({ event: e, context: ctx }) => onPosition(ctx, e, {
  kind: "LIQUIDATE", perpId: e.params.perpId, accountId: e.params.posAccountId, positionType: e.params.positionType,
  liqLot: e.params.liqLotLNS, exitPrice: e.params.liqPricePNS, deposit: e.params.posDepositCNS,
  pnl: e.params.deltaPnlCNS, funding: e.params.fundingCNS,
  liquidation: {
    markPrice: e.params.markPricePNS, liqPrice: e.params.liqPricePNS, posLot: e.params.posLotLNS,
    onOrderBook: e.params.onOrderBook,
  },
}));

for (const name of ["PositionDeleveraged", "PositionDeleveragedV2"] as const)
  indexer.onEvent({ contract: "PerplExchange", event: name, fields: F }, ({ event: e, context: ctx }) => onPosition(ctx, e, {
    kind: "DELEVERAGE", perpId: e.params.perpId, accountId: e.params.accountId, positionType: e.params.positionType,
    lot: e.params.endLotLNS, liqLot: e.params.startLotLNS - e.params.endLotLNS, exitPrice: e.params.deleveragePricePNS,
    deposit: e.params.endDepositCNS, pnl: e.params.deltaPnlCNS, funding: e.params.fundingCNS,
    liquidation: {
      markPrice: e.params.markPricePNS, liqPrice: e.params.deleveragePricePNS, posLot: e.params.startLotLNS,
      onOrderBook: false,
    },
  }));

for (const name of ["PositionUnwound", "PositionUnwoundV2", "PositionUnwoundWithoutPayment", "PositionUnwoundWithoutPaymentV2"] as const)
  indexer.onEvent({ contract: "PerplExchange", event: name, fields: F }, ({ event: e, context: ctx }) => onPosition(ctx, e, {
    kind: "UNWIND", perpId: e.params.perpId, accountId: e.params.accountId, positionType: e.params.positionType,
    lot: 0n, exitPrice: e.params.markPricePNS, pnl: e.params.positionFmvCNS - e.params.depositCNS, funding: 0n,
  }));

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

type FillInput = {
  role: "MAKER" | "TAKER";
  perpId?: bigint;
  accountId?: bigint;
  price: bigint;
  lot: bigint;
  fee: bigint;
  builderId: bigint;
  builderFee: bigint;
  amount: bigint;
  balance: bigint;
  version: number;
};

async function onFill(ctx: Ctx, e: Ev, f: FillInput) {
  const ts = e.block.timestamp, block = e.block.number, tx = e.transaction.hash;
  const cursor = await loadCursor(ctx, tx);
  const accountId = f.accountId?.toString() ?? cursor.accountId;
  const perpId = f.perpId?.toString() ?? cursor.perpId;
  if (!accountId || !perpId) {
    if (!ctx.isPreload) ctx.log.warn(`Perpl: ${f.role} fill without position context in ${tx}`);
    return;
  }
  const match = cursor.accountId === accountId && cursor.perpId === perpId;
  const side = match ? cursor.side : undefined;

  // fee of the closing fill belongs to the round trip that just closed
  let feeOnPosition = f.fee;
  if (cursor.pendingClosedTrade) {
    await finalizeClosedTrade(ctx, cursor.pendingClosedTrade, match ? f.fee : 0n, f.price);
    if (match) feeOnPosition = 0n;
    cursor.pendingClosedTrade = undefined;
  }

  const m = await loadMarket(ctx, BigInt(perpId), ts);
  const a = await loadAccount(ctx, BigInt(accountId), ts, block);
  const proto = await loadProtocol(ctx, ts);
  const pd = await loadProtocolDaily(ctx, ts);
  const md = await loadMarketDaily(ctx, m, ts);
  const [ad] = await loadAccountDaily(ctx, a, ts);
  const firstToday = ad.fills === 0; // AccountDaily may already exist from a position event
  const value = notional(m, f.price, f.lot);
  const id = evId(e);

  if (feeOnPosition > 0n) {
    const pos = await ctx.Position.get(`${accountId}-${perpId}`);
    if (pos?.isOpen) ctx.Position.set({ ...pos, feesCNS: pos.feesCNS + feeOnPosition });
  }

  ctx.Fill.set({
    id, account_id: a.id, market_id: m.id, role: f.role, side, pricePNS: f.price, lotLNS: f.lot,
    notionalCNS: value, feeCNS: f.fee, builderId: f.builderId, builderFeeCNS: f.builderFee,
    realizedPnlCNS: match ? cursor.realizedPnlCNS : 0n, amountCNS: f.amount, balanceCNS: f.balance,
    timestamp: ts, block, txHash: tx, version: f.version,
  });

  // account
  if (a.fills === 0) proto.traders += 1;
  a.fills += 1;
  a.volumeCNS += value;
  if (f.role === "MAKER") { a.makerFills += 1; a.makerVolumeCNS += value; }
  else { a.takerFills += 1; a.takerVolumeCNS += value; }
  a.balanceCNS = f.balance;
  applyPnl(a, 0n, f.fee);
  ad.volumeCNS += value;
  ad.fills += 1;
  ad.feesCNS += f.fee;
  ad.netPnlCNS -= f.fee;
  ad.cumNetPnlCNS = a.netPnlCNS;
  if (firstToday) pd.uniqueTraders += 1;
  const markerId = `${m.id}-${md.day}-${a.id}`;
  if (!(await ctx.MarketDayTrader.get(markerId))) {
    ctx.MarketDayTrader.set({ id: markerId });
    md.uniqueTraders += 1;
  }

  // fees count on both sides; volume/trades only once per match (maker side)
  proto.fills += 1;
  proto.feesCNS += f.fee;
  proto.builderFeesCNS += f.builderFee;
  pd.feesCNS += f.fee;
  pd.builderFeesCNS += f.builderFee;
  m.feesCNS += f.fee;
  md.feesCNS += f.fee;
  markPrice(m, md, f.price);
  proto.openInterestCNS += refreshOI(m, f.price);
  md.openInterestCNS = m.openInterestCNS;
  pd.openInterestCNS = proto.openInterestCNS;
  m.lastUpdatedAt = ts;

  if (f.role === "MAKER") {
    const takerSide = flip(side);
    ctx.Trade.set({
      id, market_id: m.id, maker_id: a.id, taker_id: undefined, takerSide, pricePNS: f.price, lotLNS: f.lot,
      notionalCNS: value, makerFeeCNS: f.fee, builderId: f.builderId, timestamp: ts, block, txHash: tx,
    });
    cursor.tradeIds = [...cursor.tradeIds, id];
    proto.trades += 1;
    proto.volumeCNS += value;
    m.trades += 1;
    m.volumeCNS += value;
    pd.trades += 1;
    pd.volumeCNS += value;
    md.trades += 1;
    md.volumeCNS += value;
    if (takerSide === "BUY") { pd.longVolumeCNS += value; md.longVolumeCNS += value; }
    if (takerSide === "SELL") { pd.shortVolumeCNS += value; md.shortVolumeCNS += value; }
  } else {
    for (const tid of cursor.tradeIds) {
      const t = await ctx.Trade.get(tid);
      if (t) ctx.Trade.set({ ...t, taker_id: a.id, takerSide: t.takerSide ?? side });
    }
    cursor.tradeIds = [];
  }

  ctx.Market.set(m);
  ctx.Account.set(a);
  ctx.Protocol.set(proto);
  ctx.ProtocolDaily.set(pd);
  ctx.MarketDaily.set(md);
  ctx.AccountDaily.set(ad);
  ctx.TxCursor.set({ ...cursor, realizedPnlCNS: match ? 0n : cursor.realizedPnlCNS });
}

indexer.onEvent({ contract: "PerplExchange", event: "MakerOrderFilled", fields: F }, ({ event: e, context: ctx }) => onFill(ctx, e, {
  role: "MAKER", perpId: e.params.perpId, accountId: e.params.accountId, price: e.params.pricePNS,
  lot: e.params.lotLNS, fee: e.params.feeCNS, builderId: 0n, builderFee: 0n,
  amount: e.params.amountCNS, balance: e.params.balanceCNS, version: 1,
}));
indexer.onEvent({ contract: "PerplExchange", event: "MakerOrderFilledV2", fields: F }, ({ event: e, context: ctx }) => onFill(ctx, e, {
  role: "MAKER", perpId: e.params.perpId, accountId: e.params.accountId, price: e.params.pricePNS,
  lot: e.params.lotLNS, fee: e.params.feeCNS, builderId: e.params.builderId, builderFee: e.params.builderFeeCNS,
  amount: e.params.amountCNS, balance: e.params.balanceCNS, version: 2,
}));
indexer.onEvent({ contract: "PerplExchange", event: "TakerOrderFilled", fields: F }, ({ event: e, context: ctx }) => onFill(ctx, e, {
  role: "TAKER", price: e.params.entryPricePNS, lot: e.params.lotLNS, fee: e.params.feeCNS,
  builderId: 0n, builderFee: 0n, amount: e.params.amountCNS, balance: e.params.balanceCNS, version: 1,
}));
indexer.onEvent({ contract: "PerplExchange", event: "TakerOrderFilledV2", fields: F }, ({ event: e, context: ctx }) => onFill(ctx, e, {
  role: "TAKER", price: e.params.entryPricePNS, lot: e.params.lotLNS, fee: e.params.feeCNS,
  builderId: e.params.builderId, builderFee: e.params.builderFeeCNS,
  amount: e.params.amountCNS, balance: e.params.balanceCNS, version: 2,
}));

// ---------------------------------------------------------------------------
// Accounts & collateral
// ---------------------------------------------------------------------------

indexer.onEvent({ contract: "PerplExchange", event: "AccountCreated", fields: F }, async ({ event: e, context: ctx }) => {
  const ts = e.block.timestamp;
  const a = await loadAccount(ctx, e.params.id, ts, e.block.number);
  const proto = await loadProtocol(ctx, ts);
  const pd = await loadProtocolDaily(ctx, ts);
  proto.accounts += 1;
  pd.newAccounts += 1;
  const address = e.params.account.toLowerCase();
  ctx.Account.set({ ...a, address });
  // Copas LeaderBook / FollowerVault open their Perpl account on first deposit
  const leader = await ctx.Leader.get(address);
  if (leader) ctx.Leader.set({ ...leader, perplAccount_id: a.id });
  const vault = await ctx.Vault.get(address);
  if (vault) ctx.Vault.set({ ...vault, perplAccount_id: a.id });
  ctx.Protocol.set(proto);
  ctx.ProtocolDaily.set(pd);
});

async function onFlow(ctx: Ctx, e: Ev, kind: FlowKind, accountId: bigint, amount: bigint, balance: bigint, perpId?: bigint) {
  const ts = e.block.timestamp;
  const a = await loadAccount(ctx, accountId, ts, e.block.number);
  ctx.CollateralFlow.set({
    id: evId(e), account_id: a.id, kind, perpId: perpId === undefined ? undefined : Number(perpId),
    amountCNS: amount, balanceCNS: balance, timestamp: ts, block: e.block.number, txHash: e.transaction.hash,
  });
  a.balanceCNS = balance;
  if (kind === "DEPOSIT" || kind === "WITHDRAWAL") {
    const proto = await loadProtocol(ctx, ts);
    const pd = await loadProtocolDaily(ctx, ts);
    const signed = kind === "DEPOSIT" ? amount : -amount;
    if (kind === "DEPOSIT") { a.depositsCNS += amount; proto.depositsCNS += amount; pd.depositsCNS += amount; }
    else { a.withdrawalsCNS += amount; proto.withdrawalsCNS += amount; pd.withdrawalsCNS += amount; }
    proto.netFlowCNS += signed;
    pd.netFlowCNS += signed;
    ctx.Protocol.set(proto);
    ctx.ProtocolDaily.set(pd);
  }
  ctx.Account.set(a);
}

indexer.onEvent({ contract: "PerplExchange", event: "CollateralDeposit", fields: F }, ({ event: e, context: ctx }) =>
  onFlow(ctx, e, "DEPOSIT", e.params.accountId, e.params.amountCNS, e.params.balanceCNS));
indexer.onEvent({ contract: "PerplExchange", event: "CollateralWithdrawal", fields: F }, ({ event: e, context: ctx }) =>
  onFlow(ctx, e, "WITHDRAWAL", e.params.accountId, e.params.amountCNS, e.params.balanceCNS));

indexer.onEvent({ contract: "PerplExchange", event: "IncreasePositionCollateral", fields: F }, async ({ event: e, context: ctx }) => {
  await onFlow(ctx, e, "POSITION_MARGIN_ADD", e.params.accountId, e.params.amountCNS, e.params.balanceCNS, e.params.perpId);
  const pos = await ctx.Position.get(`${e.params.accountId}-${e.params.perpId}`);
  if (pos) ctx.Position.set({ ...pos, depositCNS: e.params.positionDepositCNS, updatedAt: e.block.timestamp });
});

indexer.onEvent({ contract: "PerplExchange", event: "PositionCollateralDecreased", fields: F }, async ({ event: e, context: ctx }) => {
  await onFlow(ctx, e, "POSITION_MARGIN_REMOVE", e.params.accountId, e.params.decreaseCNS, e.params.balanceCNS, e.params.perpId);
  const pos = await ctx.Position.get(`${e.params.accountId}-${e.params.perpId}`);
  if (pos) ctx.Position.set({
    ...pos, depositCNS: e.params.endDepositCNS, entryPricePNS: e.params.endEntryPricePNS, updatedAt: e.block.timestamp,
  });
});

// ---------------------------------------------------------------------------
// Funding & market metadata
// ---------------------------------------------------------------------------

indexer.onEvent({ contract: "PerplExchange", event: "FundingEventCompleted", fields: F }, async ({ event: e, context: ctx }) => {
  const ts = e.block.timestamp;
  const m = await loadMarket(ctx, e.params.perpId, ts);
  const md = await loadMarketDaily(ctx, m, ts);
  ctx.FundingEvent.set({
    id: evId(e), market_id: m.id, fundingEventBlock: e.params.fundingEventBlock,
    specifiedRatePct100k: e.params.specifiedRatePct100k, actualRatePct100k: e.params.actualRatePct100k,
    fundingPricePNS: e.params.fundingPricePNS, fundingPaymentPNS: e.params.fundingPaymentPNS,
    fundingSumPNS: e.params.fundingSumPNS, timestamp: ts, block: e.block.number,
  });
  ctx.Market.set({
    ...m, lastFundingRatePct100k: e.params.actualRatePct100k, cumulativeFundingSumPNS: e.params.fundingSumPNS,
    lastUpdatedAt: ts,
  });
  ctx.MarketDaily.set({
    ...md, fundingEvents: md.fundingEvents + 1, sumFundingRatePct100k: md.sumFundingRatePct100k + e.params.actualRatePct100k,
  });
});

for (const name of ["ContractAdded", "ContractAddedV2"] as const)
  indexer.onEvent({ contract: "PerplExchange", event: name, fields: F }, async ({ event: e, context: ctx }) => {
    const m = await loadMarket(ctx, e.params.perpId, e.block.timestamp, true);
    ctx.Market.set({
      ...m, symbol: e.params.symbol, name: e.params.name,
      priceDecimals: Number(e.params.priceDecimals), lotDecimals: Number(e.params.lotDecimals),
    });
  });

