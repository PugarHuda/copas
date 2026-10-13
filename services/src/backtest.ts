/**
 * C3 backtest: replays a leader's fills through the Copas contract rules, deterministically.
 *
 * Mirrors copas/contracts/src:
 *  - LeaderBook: unit price u = equity / units (flow neutral), epoch high-water mark `peakUnitPrice` reset at
 *    every epoch roll, `checkpoint()` after every leader trade: dd = (peak - u) / peak > maxDDbps => breach;
 *    gross notional / equity > maxLeverageHdths => breach. `trade()` rejects opening orders outside the
 *    mandate (market mask, leverage, notional) — counted here as mandate breaches (see assumptions).
 *    Breach: pot = bond + feeEscrow, status Breached (followers reduce-only) until the next epoch.
 *  - FollowerVault.sync: target = sign(L) * min(|L| * ratioBps / 1e4, maxNotional / mark); reduce/flip first;
 *    adds refused when |mark - leaderEntry| / leaderEntry > maxChaseBps; IOC limit = mark +/- priceBandBps;
 *    stop-loss pauses copying for the rest of the epoch when equity < (start + netFlow) * (1 - stopLossBps).
 *    Epoch touch: performance fee on equity above the high-water mark, if the epoch was not breached.
 *  - claimFor: claim = min(pot * cap / capTotal, loss), loss = max(0, startEquity + netFlow - endEquity).
 */
import { type Fill, maxDrawdown } from "./leaderData.js";
import { round } from "./util.js";

export const TAKER_FEE_BPS = 3.45;

export interface FollowerParams {
  depositCNS: number; // AUSD the follower puts in the vault (mainnet cap default 100)
  ratioBps: number;
  maxNotionalCNS: number;
  maxLeverageHdths: number;
  maxChaseBps: number;
  priceBandBps: number;
  stopLossBps: number; // 0 = off
  markets?: number[]; // perpIds the follower copies (default: all)
}

export interface MandateParams {
  maxDDbps: number;
  epochLen: number; // seconds
  maxLeverageHdths?: number; // default 5000 (50x, i.e. off)
  maxNotionalCNS?: number; // default: off
  markets?: number[]; // allowed perpIds (default: all)
  feeBps?: number; // performance fee, default 0
}

export interface BacktestOpts {
  leaderCapitalCNS: number; // denominator of the leader unit price
  bondCNS?: number; // default: minBond = max(25, capTotal * 10%)
  otherFollowersCapCNS?: number; // other followers' caps sharing the pot, default 0
  latencyBlocks?: number; // 1..3, default 2
  halfSpreadBps?: number; // default 2
  driftBpsPerBlock?: number; // default 1
  takerFeeBps?: number; // default 3.45
  rebondAfterBreach?: boolean; // default true: leader re-bonds and the follow continues next epoch
  from?: number; // replay start (unix s); default first fill
  to?: number; // replay end; default last fill
}

export interface EpochResult {
  epoch: number;
  start: number;
  end: number;
  followerStartEquity: number;
  followerEndEquity: number;
  followerLoss: number;
  leaderPeakUnitPrice: number;
  leaderMinUnitPrice: number;
  leaderMaxDDbps: number;
  breached: boolean;
  breachReason: BreachReason | null;
  breachAt: number | null;
  pot: number;
  compensation: number; // min(pro-rata pot, loss)
  perfFee: number; // fee paid by the follower at the start of this epoch (on the previous epoch's profit)
}

export type BreachReason = "Drawdown" | "Leverage" | "Notional" | "Market";

export interface BacktestResult {
  params: { follower: FollowerParams; mandate: Required<MandateParams>; opts: Required<Omit<BacktestOpts, "from" | "to">> & { from: number; to: number } };
  equityCurve: { ts: number; equity: number; leaderUnitPrice: number }[];
  summary: {
    startEquity: number;
    endEquity: number;
    netPnl: number;
    returnPct: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    fees: number;
    slippageCost: number;
    perfFees: number;
    copiedFills: number;
    skippedChase: number;
    skippedBand: number;
    clampedByMargin: number;
    stopLossEpochs: number;
    epochs: number;
    breachedEpochs: number;
    compensation: number;
    netPnlWithCompensation: number;
  };
  epochs: EpochResult[];
  assumptions: string[];
}

interface Pos {
  lot: number; // signed
  entry: number;
}

const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

export function backtest(fills: Fill[], follower: FollowerParams, mandateIn: MandateParams, optsIn: BacktestOpts): BacktestResult {
  if (!fills.length) throw new Error("no fills to replay");
  if (!(optsIn.leaderCapitalCNS > 0)) throw new Error("leaderCapitalCNS must be > 0");
  if (!(follower.depositCNS > 0) || !(follower.ratioBps > 0) || !(mandateIn.epochLen > 0)) throw new Error("bad params");
  const mandate: Required<MandateParams> = { maxLeverageHdths: 5000, maxNotionalCNS: Infinity, markets: [], feeBps: 0, ...mandateIn };
  const capTotal = follower.maxNotionalCNS + (optsIn.otherFollowersCapCNS ?? 0);
  const from = optsIn.from ?? fills[0].ts;
  const to = optsIn.to ?? fills[fills.length - 1].ts;
  // request input (POST /leader/:addr/backtest): a tiny epochLen or a huge window would loop for billions of epochs
  if (!(to >= from) || (to - from) / mandate.epochLen > 10_000) throw new Error("window must be 0..10000 epochs long");
  const opts = {
    bondCNS: Math.max(25, capTotal * 0.1),
    otherFollowersCapCNS: 0,
    latencyBlocks: 2,
    halfSpreadBps: 2,
    driftBpsPerBlock: 1,
    takerFeeBps: TAKER_FEE_BPS,
    rebondAfterBreach: true,
    ...optsIn,
    from,
    to,
  };
  const slip = (opts.halfSpreadBps + opts.latencyBlocks * opts.driftBpsPerBlock) / 10_000;
  const fee = opts.takerFeeBps / 10_000;
  const lev = Math.min(follower.maxLeverageHdths, mandate.maxLeverageHdths) / 100;
  const allowedLeader = (m: number) => !mandate.markets.length || mandate.markets.includes(m);
  const allowedFollower = (m: number) => !follower.markets?.length || follower.markets.includes(m);

  // ---- state
  const price = new Map<number, number>();
  const leader = new Map<number, Pos>();
  const fpos = new Map<number, Pos>();
  let cash = follower.depositCNS; // collateral incl. realized pnl, fees
  let leaderRealized = 0;
  let paused = false;
  let status: "Active" | "Breached" | "Unbonded" = "Active";
  let feeEscrow = 0;
  let hwm = follower.depositCNS;
  const cnt = { copied: 0, chase: 0, band: 0, margin: 0, stopLoss: 0 };
  let feesPaid = 0;
  let slipCost = 0;
  let perfFees = 0;

  // seed leader positions held at the window start (plumb gives exact sizes; entry unknown => no chase check)
  for (const x of fills) {
    if (leader.has(x.market) || x.ts < from) continue;
    leader.set(x.market, { lot: round(x.positionAfter - (x.buy ? x.size : -x.size), 10), entry: 0 });
  }

  const unreal = (book: Map<number, Pos>) => {
    let u = 0;
    for (const [m, p] of book) if (p.lot && p.entry) u += p.lot * ((price.get(m) ?? p.entry) - p.entry);
    return u;
  };
  const gross = (book: Map<number, Pos>) => {
    let g = 0;
    for (const [m, p] of book) g += Math.abs(p.lot) * (price.get(m) ?? p.entry);
    return g;
  };
  const fEquity = () => cash + unreal(fpos);
  const lEquity = () => opts.leaderCapitalCNS + leaderRealized + unreal(leader);
  const unitPrice = () => lEquity() / opts.leaderCapitalCNS;

  // ---- epochs
  const epochs: EpochResult[] = [];
  let ep: EpochResult & { peak: number; netFlow: number };
  const openEpoch = (start: number) => {
    const u = unitPrice();
    const eq = fEquity();
    ep = { epoch: epochs.length + 1, start, end: start + mandate.epochLen, followerStartEquity: eq, followerEndEquity: eq, followerLoss: 0, leaderPeakUnitPrice: u, leaderMinUnitPrice: u, leaderMaxDDbps: 0, breached: false, breachReason: null, breachAt: null, pot: 0, compensation: 0, perfFee: 0, peak: u, netFlow: 0 };
    paused = false;
  };
  const finishEpoch = () => {
    const eq = fEquity();
    ep.followerEndEquity = eq;
    ep.followerLoss = Math.max(0, ep.followerStartEquity + ep.netFlow - eq);
    const share = capTotal ? (ep.pot * follower.maxNotionalCNS) / capTotal : 0;
    ep.compensation = ep.breached ? Math.min(share, ep.followerLoss) : 0;
    const { peak, netFlow, ...rest } = ep;
    epochs.push(rest);
    return eq;
  };
  const closeEpoch = () => {
    const eq = finishEpoch();
    // FollowerVault._touchEpoch: performance fee on profit above HWM, only if this epoch was not breached
    let perf = 0;
    if (!ep.breached && mandate.feeBps > 0 && eq > hwm) {
      perf = ((eq - hwm) * mandate.feeBps) / 10_000;
      cash -= perf;
      perfFees += perf;
    }
    hwm = Math.max(hwm, fEquity());
    // LeaderBook.rollEpoch: fees released if no breach; status re-evaluated on the bond
    feeEscrow = perf; // escrow deposited at the start of the next epoch is slashable during it
    if (status === "Breached") status = opts.rebondAfterBreach ? "Active" : "Unbonded";
    openEpoch(ep.end);
    ep.perfFee = perf;
  };
  const breach = (reason: BreachReason, ts: number) => {
    if (status !== "Active") return;
    status = "Breached";
    ep.breached = true;
    ep.breachReason = reason;
    ep.breachAt = ts;
    ep.pot = opts.bondCNS + feeEscrow;
    feeEscrow = 0;
  };
  const checkpoint = (ts: number) => {
    const u = unitPrice();
    ep.peak = Math.max(ep.peak, u);
    ep.leaderPeakUnitPrice = ep.peak;
    ep.leaderMinUnitPrice = Math.min(ep.leaderMinUnitPrice, u);
    const dd = ep.peak > 0 ? ((ep.peak - u) * 10_000) / ep.peak : 0;
    ep.leaderMaxDDbps = Math.max(ep.leaderMaxDDbps, Math.round(dd));
    const eq = lEquity();
    const g = gross(leader);
    if (dd > mandate.maxDDbps) breach("Drawdown", ts);
    else if (g > 0 && (eq <= 0 || (g * 100) / eq > mandate.maxLeverageHdths)) breach("Leverage", ts);
  };

  // ---- follower sync for one market (FollowerVault.sync)
  const sync = (m: number, ts: number) => {
    const mark = price.get(m)!;
    const L = leader.get(m) ?? { lot: 0, entry: 0 };
    const f = fpos.get(m) ?? { lot: 0, entry: 0 };
    // stop-loss (FollowerVault._stopLossHit)
    if (!paused && follower.stopLossBps > 0) {
      const base = ep.followerStartEquity + ep.netFlow;
      if (base > 0 && fEquity() * 10_000 < base * (10_000 - follower.stopLossBps)) {
        paused = true;
        cnt.stopLoss++;
      }
    }
    let target = 0;
    if (!paused && status === "Active" && allowedFollower(m) && L.lot !== 0) {
      const want = Math.min((Math.abs(L.lot) * follower.ratioBps) / 10_000, follower.maxNotionalCNS / mark);
      target = sgn(L.lot) * want;
    }
    if (Math.abs(target - f.lot) < 1e-12) return;
    if (slip * 10_000 > follower.priceBandBps) {
      cnt.band++; // IOC limit mark +/- band can't be filled after latency + spread
      return;
    }
    const exec = (delta: number) => {
      const px = mark * (1 + sgn(delta) * slip); // adverse
      const n = Math.abs(delta) * px;
      cash -= n * fee;
      feesPaid += n * fee;
      slipCost += Math.abs(delta) * mark * slip;
      cnt.copied++;
      return px;
    };
    // reduce / flip first
    if (f.lot !== 0 && (target === 0 || sgn(target) !== sgn(f.lot) || Math.abs(target) < Math.abs(f.lot))) {
      const flip = target === 0 || sgn(target) !== sgn(f.lot);
      const cut = flip ? Math.abs(f.lot) : Math.abs(f.lot) - Math.abs(target);
      const px = exec(-sgn(f.lot) * cut);
      cash += sgn(f.lot) * cut * (px - f.entry);
      f.lot = round(f.lot - sgn(f.lot) * cut, 12);
      fpos.set(m, f);
      if (!flip) return;
    }
    // add toward target
    let add = Math.abs(target) - Math.abs(f.lot);
    if (add <= 1e-12) return;
    if (L.entry > 0 && (Math.abs(mark - L.entry) * 10_000) / L.entry > follower.maxChaseBps) {
      cnt.chase++;
      return;
    }
    const room = (fEquity() * lev - gross(fpos)) / mark; // Perpl margin: notional / leverage <= equity
    if (room < add) {
      cnt.margin++;
      add = Math.max(0, room);
      if (add <= 1e-12) return;
    }
    const d = sgn(target) * add;
    const px = exec(d);
    f.entry = f.lot === 0 ? px : (Math.abs(f.lot) * f.entry + add * px) / (Math.abs(f.lot) + add);
    f.lot = round(f.lot + d, 12);
    fpos.set(m, f);
  };

  // ---- replay
  openEpoch(from);
  const curve: BacktestResult["equityCurve"] = [{ ts: from, equity: round(fEquity(), 4), leaderUnitPrice: 1 }];
  for (const x of fills) {
    if (x.ts < from || x.ts > to) continue;
    while (x.ts >= ep!.end) closeEpoch();
    price.set(x.market, x.price);
    // leader position + avg entry
    const L = leader.get(x.market) ?? { lot: 0, entry: 0 };
    const before = L.lot;
    const after = x.positionAfter;
    const opening = Math.abs(after) > Math.abs(before) || sgn(after) !== sgn(before);
    if (sgn(after) !== sgn(before) || before === 0) L.entry = after === 0 ? 0 : x.price;
    else if (Math.abs(after) > Math.abs(before)) L.entry = L.entry ? (Math.abs(before) * L.entry + (Math.abs(after) - Math.abs(before)) * x.price) / Math.abs(after) : x.price;
    L.lot = after;
    leader.set(x.market, L);
    leaderRealized += x.pnl - x.fee;

    // LeaderBook.trade() mandate checks on opening orders
    if (opening && status === "Active") {
      if (!allowedLeader(x.market)) breach("Market", x.ts);
      else if (x.leverage != null && x.leverage * 100 > mandate.maxLeverageHdths) breach("Leverage", x.ts);
      else if (gross(leader) > mandate.maxNotionalCNS) breach("Notional", x.ts);
    }
    checkpoint(x.ts);
    sync(x.market, x.ts);
    curve.push({ ts: x.ts, equity: round(fEquity(), 4), leaderUnitPrice: round(unitPrice(), 6) });
  }
  while (to > ep!.end) closeEpoch();
  // final partial epoch: settle at the last known marks
  ep!.end = Math.max(ep!.start, to);
  finishEpoch();

  const eq = curve.map((p) => p.equity);
  const endEquity = fEquity();
  const mdd = maxDrawdown(eq, follower.depositCNS);
  const compensation = epochs.reduce((a, e) => a + e.compensation, 0);
  return {
    params: { follower, mandate, opts: { ...opts } },
    equityCurve: curve,
    summary: {
      startEquity: follower.depositCNS,
      endEquity: round(endEquity, 4),
      netPnl: round(endEquity - follower.depositCNS, 4),
      returnPct: round(((endEquity - follower.depositCNS) / follower.depositCNS) * 100, 3),
      maxDrawdown: round(mdd, 4),
      maxDrawdownPct: round((mdd / Math.max(...eq, follower.depositCNS)) * 100, 3),
      fees: round(feesPaid, 4),
      slippageCost: round(slipCost, 4),
      perfFees: round(perfFees, 4),
      copiedFills: cnt.copied,
      skippedChase: cnt.chase,
      skippedBand: cnt.band,
      clampedByMargin: cnt.margin,
      stopLossEpochs: cnt.stopLoss,
      epochs: epochs.length,
      breachedEpochs: epochs.filter((e) => e.breached).length,
      compensation: round(compensation, 4),
      netPnlWithCompensation: round(endEquity - follower.depositCNS + compensation, 4),
    },
    epochs: epochs.map((e) => ({ ...e, followerStartEquity: round(e.followerStartEquity, 4), followerEndEquity: round(e.followerEndEquity, 4), followerLoss: round(e.followerLoss, 4), leaderPeakUnitPrice: round(e.leaderPeakUnitPrice, 6), leaderMinUnitPrice: round(e.leaderMinUnitPrice, 6), pot: round(e.pot, 4), compensation: round(e.compensation, 4), perfFee: round(e.perfFee, 4) })),
    assumptions: [
      `Source: the leader's real Perpl fills; each leader fill triggers one follower sync() of that market (keeper subscribes to leader logs).`,
      `Follower fills at the leader fill price moved adversely by ${round(slip * 10_000, 2)} bps = half-spread ${opts.halfSpreadBps} bps + ${opts.latencyBlocks} block(s) latency x ${opts.driftBpsPerBlock} bp/block drift. No tick data: real slippage can be worse in fast markets.`,
      `IOC limit = mark +/- priceBandBps (${follower.priceBandBps}); if modeled slippage exceeds the band the copy does not fill.`,
      `Taker fee ${opts.takerFeeBps} bp on every follower fill (open and close). Funding is NOT modeled for the follower; the leader curve includes funding as reported by Perpl.`,
      `Leader unit price = (capital + realized net PnL + unrealized PnL) / capital with capital = ${opts.leaderCapitalCNS} AUSD (Perpl ROI denominator when available). Deposits/withdrawals are neutral, as in LeaderBook units.`,
      `Checkpoints run after every leader fill (LeaderBook.trade calls _checkpoint). Drawdown between fills is not observed: marks only move at fill prices, so intra-trade drawdown is understated.`,
      `An opening order that LeaderBook.trade() would reject (market outside mandate, leverage above max, gross notional above max) is counted as a mandate breach: under Copas the leader would have had to trade it outside the bonded account.`,
      `Bond ${round(opts.bondCNS, 2)} AUSD (default = minBond = max(25, 10% x capTotal)); pot = bond + slashable fee escrow; capTotal = follower cap ${follower.maxNotionalCNS} + others ${opts.otherFollowersCapCNS}. Underwriter pool not included.`,
      `Compensation per breached epoch = min(pot x cap / capTotal, follower loss in that epoch) — LeaderBook.claimFor. ${opts.rebondAfterBreach ? "Leader is assumed to re-bond and the follow continues next epoch." : "Leader stays Unbonded after a breach (follower stays flat)."}`,
      `Follower margin: gross notional <= equity x min(follower, mandate) leverage; larger targets are clamped.`,
      `Positions the leader already held at the window start are copied on that market's first fill in the window, without a chase check (entry unknown).`,
      `Past performance does not predict future results; this is a deterministic replay, not a forecast.`,
    ],
  };
}
