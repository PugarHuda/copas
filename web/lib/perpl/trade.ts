/**
 * Direct Perpl trading from the passkey account (/trade). Pure helpers, no I/O (checked by trade.check.ts).
 * Order semantics verified with eth_simulateV1 on testnet 13 Oct 2026: createAccount(≥100 AUSD) → execOrder IOC fills
 * at book price, depositCNS = notional / leverage; CloseLong/CloseShort are reduce-only; orderType 4 cancels a resting order.
 */
import { parseAbi } from "viem";

export const perplTradeAbi = parseAbi([
  "struct OrderDesc { uint256 orderDescId; uint256 perpId; uint8 orderType; uint256 orderId; uint256 pricePNS; uint256 lotLNS; uint256 expiryBlock; bool postOnly; bool fillOrKill; bool immediateOrCancel; uint256 maxMatches; uint256 leverageHdths; uint256 lastExecutionBlock; uint256 amountCNS; uint256 maxNegPnlCollatBPS; }",
  "struct OrderSignature { uint256 perpId; uint256 orderId; }",
  "struct PositionBitMap { uint256 bank1; uint256 bank2; uint256 bank3; uint256 bank4; }",
  "struct AccountInfo { uint256 accountId; uint256 balanceCNS; uint256 lockedBalanceCNS; uint8 frozen; address accountAddr; PositionBitMap positions; }",
  "struct PositionInfo { uint256 accountId; uint256 nextNodeId; uint256 prevNodeId; uint8 positionType; uint256 depositCNS; uint256 pricePNS; uint256 lotLNS; uint256 entryBlock; int256 pnlCNS; int256 deltaPnlCNS; int256 premiumPnlCNS; }",
  "struct OrderLock { uint32 orderLockId; uint32 nextOrderLockId; uint32 prevOrderLockId; uint8 orderType; uint40 lotLNS; uint80 amountCNS; }",
  "struct Order { uint32 accountId; uint8 orderType; uint24 priceONS; uint40 lotLNS; uint16 recycleFeeRaw; uint32 expiryBlock; uint16 leverageHdths; uint16 orderId; uint16 prevOrderId; uint16 nextOrderId; uint16 maxNegPnlCollatBPS; }",
  "function execOrder(OrderDesc orderDesc) returns (OrderSignature signature)",
  "function createAccount(uint256 amountCNS) returns (uint256 accountId)",
  "function depositCollateral(uint256 amountCNS)",
  "function withdrawCollateral(uint256 amountCNS)",
  "function getAccountByAddr(address accountAddress) view returns (AccountInfo accountInfo)",
  "function getPosition(uint256 perpId, uint256 accountId) view returns (PositionInfo positionInfo, uint256 markPricePNS, bool markPriceValid)",
  "function getPerpOrderLocks(uint256 accountId, uint256 perpId) view returns (OrderLock[] perpOrderLocks)",
  "function getOrder(uint256 perpId, uint256 orderId) view returns (Order order)",
  "function getMinAccountOpenCNS() view returns (uint256)",
  "event TakerOrderFilledV2(uint256 entryPricePNS, uint256 collatPricePNS, uint256 pnlPricePNS, uint256 lotLNS, uint256 feeCNS, int256 amountCNS, uint256 balanceCNS, uint256 builderId, uint256 builderFeeCNS)",
  "event OrderPlaced(uint256 orderId, uint256 lotLNS, uint256 lockedBalanceCNS, int256 amountCNS, uint256 balanceCNS)",
]);

export const OPEN_LONG = 0;
export const OPEN_SHORT = 1;
export const CLOSE_LONG = 2;
export const CLOSE_SHORT = 3;
export const CANCEL = 4;

/** Market metadata from the Perpl testnet /v1/pub/context (human scales). */
export type TMarket = {
  id: number;
  sym: string;
  pd: number; // price decimals
  sd: number; // size decimals
  maxLev: number; // initial margin, x
  maintLev: number; // maintenance, x
  takerBp: number;
  maxSlipBps: number;
  mnpBps: number; // order_max_neg_pnl_collat_bps
};

type Ctx = { markets: { id: number; symbol: string; order_max_market_slippage_bps?: number; order_max_neg_pnl_collat_bps?: number; config: { is_open: boolean; price_decimals: number; size_decimals: number; initial_margin: number; maintenance_margin: number; taker_fee: number } }[] };
export const toTMarkets = (c: Ctx): TMarket[] =>
  c.markets
    .filter((m) => m.config.is_open)
    .map((m) => ({
      id: m.id,
      sym: m.symbol,
      pd: m.config.price_decimals,
      sd: m.config.size_decimals,
      maxLev: m.config.initial_margin / 100,
      maintLev: m.config.maintenance_margin / 100,
      takerBp: m.config.taker_fee / 100,
      maxSlipBps: m.order_max_market_slippage_bps ?? 100,
      mnpBps: m.order_max_neg_pnl_collat_bps ?? DEFAULT_MNP_BPS,
    }));

export const toPNS = (p: number, m: TMarket) => BigInt(Math.round(p * 10 ** m.pd));
export const toLNS = (s: number, m: TMarket) => BigInt(Math.floor(s * 10 ** m.sd + 1e-9));
export const fromPNS = (v: bigint | number, m: TMarket) => Number(v) / 10 ** m.pd;
export const fromLNS = (v: bigint | number, m: TMarket) => Number(v) / 10 ** m.sd;

/**
 * maxNegPnlCollatBPS: how much negative PnL vs the mark price (bps of the resulting position's notional) a fill may
 * collateralize. 0 is NOT "default" onchain, it means "refuse any fill below mark for a short / above mark for a long":
 * Perpl then reverts TakerOrderSettlementFailed (0xb29d1949, resultCode 14) whenever the book sits on the wrong side of
 * the mark, which on testnet flips block to block. 1000 = Perpl's market default and dex-sdk DEFAULT_MAX_NEG_PNL_COLLAT_BPS.
 */
export const DEFAULT_MNP_BPS = 1000;

export type OrderInput = { perpId: number; orderType: number; pricePNS: bigint; lotLNS: bigint; leverageHdths: bigint; ioc: boolean; orderId?: bigint; expiryBlock?: bigint; mnpBps?: number };
/** OrderDesc for execOrder. IOC orders expire 20 blocks out (Perpl order_ttl_blocks); resting limits never (expiry 0). */
export function orderDesc(o: OrderInput, block: bigint) {
  return {
    orderDescId: BigInt(Date.now() % 1e12),
    perpId: BigInt(o.perpId),
    orderType: o.orderType,
    orderId: o.orderId ?? 0n,
    pricePNS: o.pricePNS,
    lotLNS: o.lotLNS,
    expiryBlock: o.expiryBlock ?? (o.ioc ? block + 20n : 0n),
    postOnly: false,
    fillOrKill: false,
    immediateOrCancel: o.ioc,
    maxMatches: 0n,
    leverageHdths: o.leverageHdths,
    lastExecutionBlock: 0n,
    amountCNS: 0n,
    maxNegPnlCollatBPS: BigInt(o.mnpBps ?? DEFAULT_MNP_BPS),
  };
}

export type Level = { p: number; s: number };
/** Walk the book for `size` base units. Returns average fill price and the worst level touched; null if the book runs out. */
export function walk(levels: Level[], size: number): { avg: number; worst: number } | null {
  let left = size;
  let cost = 0;
  for (const l of levels) {
    const take = Math.min(left, l.s);
    cost += take * l.p;
    left -= take;
    if (left <= 1e-12) return { avg: cost / size, worst: l.p };
  }
  return null;
}

/**
 * Isolated-margin liquidation estimate (same formula as lib/perpl/onchain.ts liqPrice):
 * long P = (qM − E) / (q(1 − 1/ML)), short P = (E + qM) / (q(1 + 1/ML)). Ignores fees and impact.
 */
export function liqPrice(side: "long" | "short", q: number, mark: number, posEquity: number, maintLev: number) {
  if (q <= 0 || maintLev <= 0) return null;
  const mmf = 1 / maintLev;
  const p = side === "long" ? (q * mark - posEquity) / (q * (1 - mmf)) : (posEquity + q * mark) / (q * (1 + mmf));
  return p > 0 ? p : null;
}

// ---------------------------------------------------------------- mandate rail

/** The trader's self-declared mandate, same fields and units as LeaderBook's Mandate (display units). */
export type Mandate = { maxDD: number; maxLev: number; maxNotional: number; markets: string[] };
/** Registry markets a LeaderBook mandate can allow (CopasRegistry order on testnet). */
export const REGISTRY_MARKETS = ["BTC", "ETH", "SOL", "MON"] as const;
export const DEFAULT_MANDATE: Mandate = { maxDD: 15, maxLev: 5, maxNotional: 1000, markets: ["BTC", "ETH", "SOL"] };

/** Unit accounting like LeaderBook: deposits/withdrawals mint/burn units at the current unit price, DD is from the peak unit price. */
export type Ledger = { units: number; peak: number };
export const unitPrice = (l: Ledger, equity: number) => (l.units > 0 ? equity / l.units : 1);
export const drawdown = (l: Ledger, equity: number) => (l.peak > 0 ? Math.max(0, ((l.peak - unitPrice(l, equity)) / l.peak) * 100) : 0);
/** Ledger after observing `equity` (raises the peak) and then moving `flow` AUSD in (+) or out (−) at that unit price. */
export function touch(l: Ledger | null, equity: number, flow = 0): Ledger {
  if (!l || l.units <= 0) return { units: Math.max(equity + flow, 0), peak: 1 };
  const u = unitPrice(l, equity);
  return { units: Math.max(0, l.units + (u > 0 ? flow / u : 0)), peak: Math.max(l.peak, u) };
}

export type Check = { rule: "Market" | "Leverage" | "Notional" | "Drawdown"; ok: boolean; detail: string };
/**
 * Mirrors LeaderBook.trade (market allowed, order leverage ≤ max, gross + order notional ≤ max notional) plus the
 * checkpoint rules it runs right after (drawdown ≤ max, gross / equity ≤ max leverage). Closing orders always pass,
 * as in LeaderBook: a leader may always reduce.
 */
export function checkMandate(m: Mandate, o: { sym: string; lev: number; notional: number; reduce: boolean; gross: number; equity: number; dd: number }): Check[] {
  if (o.reduce) return [];
  const after = o.gross + o.notional;
  const effLev = o.equity > 0 ? after / o.equity : Infinity;
  return [
    { rule: "Market", ok: m.markets.includes(o.sym), detail: o.sym },
    { rule: "Leverage", ok: o.lev <= m.maxLev + 1e-9 && effLev <= m.maxLev + 1e-9, detail: `${o.lev}x order · ${Number.isFinite(effLev) ? effLev.toFixed(2) : "∞"}x account ≤ ${m.maxLev}x` },
    { rule: "Notional", ok: after <= m.maxNotional + 1e-9, detail: `${after.toFixed(2)} ≤ ${m.maxNotional} AUSD` },
    { rule: "Drawdown", ok: o.dd <= m.maxDD, detail: `${o.dd.toFixed(2)}% ≤ ${m.maxDD}%` },
  ];
}

/** True when `b` allows something `a` does not (raising a limit). Loosening needs a fresh passkey, like a LeaderBook re-declare. */
export const looser = (a: Mandate, b: Mandate) => b.maxDD > a.maxDD || b.maxLev > a.maxLev || b.maxNotional > a.maxNotional || b.markets.some((x) => !a.markets.includes(x));
