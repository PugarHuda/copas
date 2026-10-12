import { describe, expect, it } from 'vitest';
import { MM_DEFAULTS as M, breachProbability, epochsToQuote, mintAmount, normCdf, planQuotes, quotePrices, type Order } from '../src/mmLogic.js';

const hour = 3600;
const base = { unitPrice: 1, peak: 1, maxDDbps: 1500, secondsLeft: hour };

describe('breach probability', () => {
  it('normCdf matches known values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(normCdf(-1.96)).toBeCloseTo(0.025, 3);
  });
  it('far from the limit with an hour left: the floor', () => {
    expect(breachProbability(base)).toBeCloseTo(M.pFloor, 4);
  });
  it('rises as drawdown nears the mandate and with more time', () => {
    const p = (dd: number, s = hour) => breachProbability({ ...base, unitPrice: 1 - dd, secondsLeft: s });
    expect(p(0.10)).toBeGreaterThan(p(0.05));
    expect(p(0.14)).toBeGreaterThan(p(0.10));
    expect(p(0.13, 4 * hour)).toBeGreaterThan(p(0.13, hour));
    // dd 13% of 15%: b = ln(.87/.85) = 0.0233, s = 0.1*sqrt(1/24) = 0.0204 -> 2*Phi(-1.14) = 0.254
    const pd = 2 * normCdf(-Math.log(0.87 / 0.85) / (0.1 * Math.sqrt(1 / 24)));
    expect(p(0.13)).toBeCloseTo(1 - (1 - M.pFloor) * (1 - pd), 6);
  });
  it('past the limit or zero time', () => {
    expect(breachProbability({ ...base, unitPrice: 0.84 })).toBe(M.pCap);
    expect(breachProbability({ ...base, unitPrice: 0.9, secondsLeft: 0 })).toBeCloseTo(M.pFloor, 6);
    expect(breachProbability({ ...base, unitPrice: 1.2 })).toBeCloseTo(M.pFloor, 4); // above peak (not yet checkpointed): no drawdown
  });
  it('fresh CRE risk notes add, stale ones do not', () => {
    const p0 = breachProbability(base);
    const p3 = breachProbability({ ...base, risk: { level: 3, ageSec: 60 } });
    expect(p3).toBeCloseTo(1 - (1 - p0) * (1 - M.riskBump[3]), 6);
    expect(breachProbability({ ...base, risk: { level: 3, ageSec: M.riskMaxAgeSec + 1 } })).toBe(p0);
  });
});

describe('quote prices (price precision 1e4, tick 10)', () => {
  it('centres on p with the spread, on the tick grid', () => {
    expect(quotePrices(0.3, 10_000, 10, 0.04)).toEqual({ bid: 2800, ask: 3200 });
    expect(quotePrices(0.3333, 10_000, 10, 0.04)).toEqual({ bid: 3130, ask: 3540 });
  });
  it('stays inside (0, 1)', () => {
    expect(quotePrices(0.01, 10_000, 10, 0.04)).toEqual({ bid: 10, ask: 300 });
    expect(quotePrices(0.99, 10_000, 10, 0.04)).toEqual({ bid: 9700, ask: 9990 });
  });
});

describe('epochs to quote', () => {
  it('current epoch, plus next one near the end, only next once ended', () => {
    expect(epochsToQuote(3n, 1000n, 0n, 900)).toEqual([3n]);
    expect(epochsToQuote(3n, 1000n, 200n, 900)).toEqual([3n, 4n]);
    expect(epochsToQuote(3n, 1000n, 1000n, 900)).toEqual([4n]);
  });
});

describe('mint amount', () => {
  it('mints when DOWN runs low, bounded by series cap and budget', () => {
    expect(mintAmount({ downHeld: 0, upHeld: 0, budget: 500 })).toBe(M.mintSize);
    expect(mintAmount({ downHeld: M.quoteSize, upHeld: 0, budget: 500 })).toBe(0);
    expect(mintAmount({ downHeld: 0, upHeld: M.maxMintPerSeries - 30, budget: 500 })).toBe(30);
    expect(mintAmount({ downHeld: 0, upHeld: M.maxMintPerSeries, budget: 500 })).toBe(0);
    expect(mintAmount({ downHeld: 0, upHeld: 0, budget: 12.7 })).toBe(12);
  });
});

describe('cancel/replace plan', () => {
  const o = (id: number, isBuy: boolean, price: number, size = 5000n): Order => ({ id: BigInt(id), isBuy, price, size });
  const base = { target: { bid: 2800, ask: 3200 }, quoteSize: 5000n, minSize: 100n, requoteUnits: 100, sellable: 10_000n, buyable: 10_000n };
  it('posts both sides on an empty book', () => {
    expect(planQuotes({ ...base, orders: [] })).toMatchObject({ cancel: [], buy: { price: 2800, size: 5000n }, sell: { price: 3200, size: 5000n } });
  });
  it('leaves quotes within the threshold alone', () => {
    expect(planQuotes({ ...base, orders: [o(1, true, 2750), o(2, false, 3290)] })).toBeNull();
  });
  it('replaces a side that moved, was mostly filled, or is duplicated', () => {
    expect(planQuotes({ ...base, orders: [o(1, true, 2600), o(2, false, 3200)] })).toMatchObject({ cancel: [1n], buy: { price: 2800 } });
    expect(planQuotes({ ...base, orders: [o(1, true, 2800), o(2, false, 3200, 1000n)] })).toMatchObject({ cancel: [2n], sell: { size: 5000n } });
    expect(planQuotes({ ...base, orders: [o(1, true, 2800), o(3, true, 2800), o(2, false, 3200)] })?.cancel).toEqual([1n, 3n]);
  });
  it('sizes to what is fundable and cancels a side it cannot fund (inventory cap)', () => {
    expect(planQuotes({ ...base, orders: [], sellable: 700n })?.sell).toEqual({ price: 3200, size: 700n });
    const p = planQuotes({ ...base, orders: [o(1, true, 2800), o(2, false, 3200)], target: { bid: 2500, ask: 3200 }, buyable: 0n });
    expect(p).toEqual({ cancel: [1n], why: "bid: replace 1 (cancel only)" });
    expect(planQuotes({ ...base, orders: [o(2, false, 3200)], buyable: 50n })).toBeNull(); // below minSize, nothing resting: nothing to do
  });
});
