// Pure DOWN-token market-maker logic (no I/O). Driven by src/mm.ts, unit-tested in test/mm.test.ts.

export type MmParams = {
  sigmaDaily: number; // daily volatility of the leader's unit price (log returns)
  pFloor: number; // base breach rate the diffusion model cannot see (jumps, liquidations, bad fills)
  pCap: number;
  spread: number; // full bid-ask width, in probability points
  requote: number; // re-quote a side when its price is this far (probability points) from the target
  quoteSize: number; // DOWN per side
  mintSize: number; // pairs minted at a time
  maxMintPerSeries: number; // UP balance (= pairs minted, the MM never sells UP) cap per series
  maxDown: number; // DOWN inventory cap: stop bidding above it
  riskBump: number[]; // extra breach probability per CRE riskLevel 0..3
  riskMaxAgeSec: number; // ignore CRE notes older than this
  premintSec: number; // mint + list epoch+1 when the current epoch has less than this left
};

export const MM_DEFAULTS: MmParams = {
  sigmaDaily: 0.1,
  pFloor: 0.02,
  pCap: 0.98,
  spread: 0.04,
  requote: 0.005,
  quoteSize: 50,
  mintSize: 100,
  maxMintPerSeries: 300,
  maxDown: 200,
  riskBump: [0, 0.05, 0.15, 0.35],
  riskMaxAgeSec: 86_400,
  premintSec: 900,
};

/** Standard normal CDF (Abramowitz-Stegun 7.1.26, |err| < 1.5e-7). */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export type BreachInput = {
  unitPrice: number; // LeaderBook.unitPrice() (any scale, same as peak)
  peak: number; // LeaderBook.peakUnitPrice(): resets to the unit price at every epoch roll
  maxDDbps: number; // mandate.maxDDbps
  secondsLeft: number; // until epochEnd (a whole epochLen for a pre-minted next epoch)
  risk?: { level: number; ageSec: number }; // CopasRiskConsumer.latest(leader)
};

/**
 * Fair DOWN price = probability the leader breaches its drawdown mandate before the epoch ends.
 *
 *   dd     = max(0, (peak - u) / peak)                      live drawdown
 *   b      = ln((1 - dd) / (1 - maxDD))                     log distance from u to the breach level peak·(1 - maxDD)
 *   s      = sigmaDaily · sqrt(secondsLeft / 86400)         unit-price vol over the time left
 *   pDiff  = 2 · Φ(-b / s)                                  reflection principle: driftless log-price touches the barrier
 *   r      = riskBump[CRE riskLevel] if the note is fresh, else 0
 *   p      = clamp(1 - (1 - pFloor)(1 - pDiff)(1 - r), pFloor, pCap)
 *
 * Already past the limit (dd >= maxDD) means the next checkpoint breaches: p = pCap.
 */
export function breachProbability(x: BreachInput, m: MmParams = MM_DEFAULTS): number {
  const D = x.maxDDbps / 10_000;
  const dd = x.peak > 0 ? Math.max(0, (x.peak - x.unitPrice) / x.peak) : 0;
  if (dd >= D) return m.pCap;
  const b = Math.log((1 - dd) / (1 - D));
  const s = m.sigmaDaily * Math.sqrt(Math.max(0, x.secondsLeft) / 86_400);
  const pDiff = s > 0 ? 2 * normCdf(-b / s) : 0;
  const r = x.risk && x.risk.ageSec <= m.riskMaxAgeSec ? (m.riskBump[x.risk.level] ?? m.riskBump.at(-1)!) : 0;
  const p = 1 - (1 - m.pFloor) * (1 - pDiff) * (1 - r);
  return Math.min(m.pCap, Math.max(m.pFloor, p));
}

/** Bid/ask around p in Kuru price units (pricePrecision per 1 AUSD), on the tick grid, inside (0, 1). The bid never drops below p/2. */
export function quotePrices(p: number, pricePrecision: number, tickSize: number, spread: number) {
  const ticks = (v: number) => v * pricePrecision / tickSize;
  const lo = tickSize, hi = pricePrecision - tickSize;
  const bid = Math.min(hi - tickSize, Math.max(lo, Math.floor(ticks(p - Math.min(spread / 2, p / 2)) + 1e-9) * tickSize));
  const ask = Math.max(bid + tickSize, Math.min(hi, Math.ceil(ticks(p + spread / 2) - 1e-9) * tickSize));
  return { bid, ask };
}

/** Which epochs to quote: the current one while it runs, plus epoch+1 in its last `premintSec`. */
export function epochsToQuote(epoch: bigint, epochEnd: bigint, now: bigint, premintSec: number): bigint[] {
  const out: bigint[] = [];
  if (now < epochEnd) out.push(epoch);
  if (epochEnd - now <= BigInt(premintSec)) out.push(epoch + 1n);
  return out;
}

/** Pairs to mint for a series now (0 = none): when DOWN to sell runs below one quote, up to the per-series cap and the tick budget. */
export function mintAmount(x: { downHeld: number; upHeld: number; budget: number }, m: MmParams = MM_DEFAULTS): number {
  if (x.downHeld >= m.quoteSize) return 0;
  return Math.max(0, Math.floor(Math.min(m.mintSize, m.maxMintPerSeries - x.upHeld, x.budget)));
}

export type Order = { id: bigint; isBuy: boolean; price: number; size: bigint };
export type QuotePlan = { cancel: bigint[]; buy?: { price: number; size: bigint }; sell?: { price: number; size: bigint }; why: string };

/**
 * Cancel/replace decision for one book. A side is kept when it is one order within `requoteUnits` of the
 * target and at least half a quote; otherwise all our orders on it are cancelled and one fresh order posted
 * (if its size reaches minSize). `sellable` / `buyable` are sizes (sizePrecision units) we can fund once
 * that side's old orders are cancelled. Null = nothing to do.
 */
export function planQuotes(x: {
  orders: Order[]; target: { bid: number; ask: number }; quoteSize: bigint; minSize: bigint;
  requoteUnits: number; sellable: bigint; buyable: bigint;
}): QuotePlan | null {
  const plan: QuotePlan = { cancel: [], why: '' };
  const why: string[] = [];
  for (const isBuy of [true, false]) {
    const mine = x.orders.filter((o) => o.isBuy === isBuy);
    const target = isBuy ? x.target.bid : x.target.ask;
    const avail = isBuy ? x.buyable : x.sellable;
    const want = avail < x.quoteSize ? avail : x.quoteSize;
    const side = isBuy ? 'bid' : 'ask';
    const ok = mine.length === 1 && Math.abs(mine[0].price - target) < x.requoteUnits && mine[0].size * 2n >= x.quoteSize;
    if (ok) continue;
    if (!mine.length && want < x.minSize) { why.push(`${side}: nothing to post`); continue; }
    plan.cancel.push(...mine.map((o) => o.id));
    if (want >= x.minSize) plan[isBuy ? 'buy' : 'sell'] = { price: target, size: want };
    why.push(`${side}: ${mine.length ? `replace ${mine.length}` : 'new'}${want >= x.minSize ? ` @${target}x${want}` : ' (cancel only)'}`);
  }
  plan.why = why.join(', ');
  return plan.cancel.length || plan.buy || plan.sell ? plan : null;
}
