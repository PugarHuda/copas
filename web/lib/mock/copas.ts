// MOCK until contracts deployed.
// Shapes mirror the LeaderBook / FollowerVault / UnderwriterPool / BreachMarket reads in copas/abis,
// already converted to display units (AUSD, %, x). lib/copas/data.ts swaps these for onchain reads.

export type LeaderStatus = "active" | "unbonded" | "breached" | "closed";

export type Leader = {
  book: `0x${string}`; // LeaderBook address
  owner: `0x${string}`;
  name: string;
  agent?: { erc8004Id: number; model: string };
  status: LeaderStatus;
  bond: number;
  underwritten: number;
  maxDD: number; // declared %
  liveDD: number; // current epoch drawdown %
  unitPrice: number;
  peakUnitPrice: number;
  epoch: number;
  epochEnd: number; // ms
  epochLenH: number;
  followerAum: number;
  followers: number;
  capacity: number; // AUM capacity (kBond × bond etc.)
  maxLeverage: number;
  maxNotional: number;
  markets: string[];
  feePct: number;
  tier: "konservatif" | "moderat" | "agresif" | "custom";
  return30d: number; // % unit price change
  /** Address whose Perpl history feeds backtest / AI analysis (@copas/services). On chain this is the LeaderBook itself. */
  perplAccount?: string;
};

const now = Date.UTC(2026, 9, 4, 3, 0);
const H = 3_600_000;

export const MOCK_LEADERS: Leader[] = [
  {
    book: "0x1a7e000000000000000000000000000000c0a5a1",
    owner: "0x5d2bf64b0000000000000000000000000000a001",
    name: "Sabar Trend",
    status: "active",
    bond: 500,
    underwritten: 1200,
    maxDD: 15,
    liveDD: 4.2,
    unitPrice: 1.184,
    peakUnitPrice: 1.236,
    epoch: 6,
    epochEnd: now + 51 * H,
    epochLenH: 168,
    followerAum: 3640,
    followers: 21,
    capacity: 10000,
    maxLeverage: 5,
    maxNotional: 25000,
    markets: ["BTC", "ETH", "SOL"],
    feePct: 15,
    tier: "moderat",
    return30d: 11.8,
    perplAccount: "0xecbd5c9c1e3ef761bbedcb9f4f08839bc8f22059", // real Perpl trader, used only to demo backtest/analysis
  },
  {
    book: "0x1a7e000000000000000000000000000000c0a5a2",
    owner: "0xd43866850000000000000000000000000000a002",
    name: "Pelan Pasti",
    status: "active",
    bond: 800,
    underwritten: 0,
    maxDD: 5,
    liveDD: 0.9,
    unitPrice: 1.041,
    peakUnitPrice: 1.05,
    epoch: 9,
    epochEnd: now + 102 * H,
    epochLenH: 168,
    followerAum: 4100,
    followers: 34,
    capacity: 16000,
    maxLeverage: 3,
    maxNotional: 15000,
    markets: ["BTC", "ETH"],
    feePct: 10,
    tier: "konservatif",
    return30d: 3.1,
  },
  {
    book: "0x1a7e000000000000000000000000000000c0a5a3",
    owner: "0x8004a9e70000000000000000000000000000a003",
    name: "Momentum-7",
    agent: { erc8004Id: 412, model: "BTC momentum, deterministic, explained by Kimi K3" },
    status: "active",
    bond: 250,
    underwritten: 400,
    maxDD: 10,
    liveDD: 6.8,
    unitPrice: 0.972,
    peakUnitPrice: 1.043,
    epoch: 3,
    epochEnd: now + 9 * H,
    epochLenH: 24,
    followerAum: 980,
    followers: 12,
    capacity: 5000,
    maxLeverage: 4,
    maxNotional: 6000,
    markets: ["BTC"],
    feePct: 12,
    tier: "custom",
    return30d: -2.8,
    perplAccount: "0x92e03935e81651213d394285611afbc99f5238d2", // real Perpl trader, demo only
  },
  {
    book: "0x1a7e000000000000000000000000000000c0a5a4",
    owner: "0xecbd5c9c0000000000000000000000000000a004",
    name: "Gas Pol",
    status: "breached",
    bond: 300,
    underwritten: 600,
    maxDD: 30,
    liveDD: 31.6,
    unitPrice: 0.811,
    peakUnitPrice: 1.186,
    epoch: 4,
    epochEnd: now + 30 * H,
    epochLenH: 168,
    followerAum: 2250,
    followers: 17,
    capacity: 6000,
    maxLeverage: 10,
    maxNotional: 30000,
    markets: ["BTC", "ETH", "SOL", "MON"],
    feePct: 20,
    tier: "agresif",
    return30d: -18.9,
  },
  {
    book: "0x1a7e000000000000000000000000000000c0a5a5",
    owner: "0xedcd74710000000000000000000000000000a005",
    name: "Kopi Pagi",
    status: "unbonded",
    bond: 40,
    underwritten: 0,
    maxDD: 15,
    liveDD: 2.4,
    unitPrice: 1.067,
    peakUnitPrice: 1.09,
    epoch: 2,
    epochEnd: now + 70 * H,
    epochLenH: 168,
    followerAum: 610,
    followers: 6,
    capacity: 800,
    maxLeverage: 5,
    maxNotional: 8000,
    markets: ["BTC", "ETH", "SOL"],
    feePct: 15,
    tier: "moderat",
    return30d: 6.7,
  },
];

export const findMockLeader = (book: string) => MOCK_LEADERS.find((l) => l.book.toLowerCase() === book.toLowerCase());

/** Deterministic pseudo-random walk so the unit-price chart is stable between renders. */
export function mockUnitCurve(l: Leader, days = 30) {
  let seed = parseInt(l.book.slice(-4), 16);
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const pts: { t: number; u: number; hwm: number; epoch: number }[] = [];
  const start = l.unitPrice / (1 + l.return30d / 100);
  let u = start;
  let hwm = u;
  const epochMs = l.epochLenH * H;
  for (let i = 0; i <= days * 4; i++) {
    const t = now - (days * 4 - i) * 6 * H;
    const drift = (l.unitPrice - start) / (days * 4);
    u = Math.max(0.5, u + drift + (rnd() - 0.5) * 0.012 * (l.maxLeverage / 4));
    const ep = Math.floor((t - (now - days * 86_400_000)) / epochMs);
    if (i > 0 && ep !== pts[pts.length - 1].epoch) hwm = u; // HWM resets each epoch
    hwm = Math.max(hwm, u);
    pts.push({ t, u, hwm, epoch: ep });
  }
  pts[pts.length - 1].u = l.unitPrice;
  return pts;
}

export type Checkpoint = { epoch: number; t: number; unitPrice: number; ddPct: number; leverage: number; tx: string; breach?: string };

export function mockCheckpoints(l: Leader): Checkpoint[] {
  const c: Checkpoint[] = [];
  for (let i = 0; i < 8; i++) {
    const dd = Math.max(0, l.liveDD - i * 0.7 + (i % 3) * 0.4);
    c.push({ epoch: l.epoch - (i > 4 ? 1 : 0), t: now - i * 5 * H, unitPrice: l.unitPrice * (1 + i * 0.002), ddPct: dd, leverage: Math.min(l.maxLeverage, 1.5 + (i % 4) * 0.6), tx: `0x${(0xc0ffee + i * 7919 + parseInt(l.book.slice(-2), 16)).toString(16).padStart(64, "0")}` });
  }
  if (l.status === "breached") c[0].breach = "DRAWDOWN";
  return c;
}

export const MOCK_POSITIONS: Record<string, { market: string; side: "long" | "short"; size: number; entry: number; mark: number; leverage: number; upnl: number }[]> = {
  "0x1a7e000000000000000000000000000000c0a5a1": [
    { market: "BTC", side: "long", size: 0.12, entry: 83210, mark: 84790, leverage: 3.1, upnl: 189.6 },
    { market: "SOL", side: "short", size: 18, entry: 121.4, mark: 119.6, leverage: 2.2, upnl: 32.4 },
  ],
  "0x1a7e000000000000000000000000000000c0a5a2": [{ market: "ETH", side: "long", size: 1.1, entry: 2650, mark: 2679, leverage: 1.4, upnl: 31.9 }],
  "0x1a7e000000000000000000000000000000c0a5a3": [{ market: "BTC", side: "short", size: 0.035, entry: 84400, mark: 84790, leverage: 3.6, upnl: -13.7 }],
  "0x1a7e000000000000000000000000000000c0a5a4": [],
  "0x1a7e000000000000000000000000000000c0a5a5": [{ market: "BTC", side: "long", size: 0.02, entry: 84010, mark: 84790, leverage: 2.6, upnl: 15.6 }],
};

/* ------------------------------- follower vault ------------------------------ */

export const MOCK_VAULT = {
  vault: "0x7a017000000000000000000000000000000f0011" as `0x${string}`,
  leader: MOCK_LEADERS[0],
  deposited: 100,
  equity: 106.42,
  hwm: 108.1,
  paused: false,
  params: { ratioPct: 2.5, maxNotional: 400, maxLeverage: 4, maxChaseBps: 30, priceBandBps: 50, stopLossPct: 20 },
  claimable: [{ leader: MOCK_LEADERS[3], epoch: 4, loss: 14.2, estimate: 12.9 }],
  positions: [
    { market: "BTC", side: "long" as const, size: 0.003, entry: 83290, mark: 84790, upnl: 4.5, leaderSize: 0.12 },
    { market: "SOL", side: "short" as const, size: 0.45, entry: 121.2, mark: 119.6, upnl: 0.72, leaderSize: 18 },
  ],
  // C7 execution proof: leader fill vs follower fill per copy
  fills: [
    { t: now - 2.1 * H, market: "BTC", side: "long" as const, leaderPx: 83210, followerPx: 83290, slipBps: 9.6, fee: 0.086, funding: -0.004, blocks: 3, tx: "0x" + "a1".repeat(32) },
    { t: now - 7.4 * H, market: "SOL", side: "short" as const, leaderPx: 121.4, followerPx: 121.2, slipBps: 16.5, fee: 0.019, funding: 0.001, blocks: 2, tx: "0x" + "b2".repeat(32) },
    { t: now - 30 * H, market: "ETH", side: "long" as const, leaderPx: 2610.5, followerPx: 2612.1, slipBps: 6.1, fee: 0.027, funding: -0.002, blocks: 4, tx: "0x" + "c3".repeat(32) },
  ],
};

/* --------------------------------- underwriting -------------------------------- */

export const MOCK_UW = MOCK_LEADERS.filter((l) => l.status !== "unbonded").map((l, i) => ({
  leader: l,
  pool: l.underwritten,
  feeApr: [14.2, 0, 21.7, 0][i] ?? 0,
  breaches: l.status === "breached" ? 1 : 0,
  myStake: i === 0 ? 50 : 0,
}));

/* ----------------------------------- DOWN ----------------------------------- */

export function mockDownBook(l: Leader) {
  const p = Math.min(0.95, Math.max(0.03, l.liveDD / l.maxDD / 2 + (l.status === "breached" ? 0.9 : 0)));
  return {
    epoch: l.epoch,
    downPrice: p,
    upPrice: 1 - p,
    supply: 320,
    bids: [0.02, 0.04, 0.06].map((d, i) => ({ px: Math.max(0.01, p - d), size: 40 + i * 25 })),
    asks: [0.02, 0.04, 0.06].map((d, i) => ({ px: Math.min(0.99, p + d), size: 35 + i * 30 })),
  };
}

/* ------------------------------------ proof ----------------------------------- */

export const MOCK_PROOF = {
  breaches: [
    {
      leader: MOCK_LEADERS[3],
      epoch: 4,
      reason: "DRAWDOWN" as const,
      block: 110_311_204,
      tx: "0x" + "de".repeat(32),
      peak: 1.186,
      unit: 0.811,
      equity: 2_190.42,
      units: 2_700.89,
      slash: 900,
      capTotal: 2_250,
      claimed: 612.4,
    },
  ],
  privyDeny: [
    { t: now - 26 * H, wallet: "keeper-1", action: "AUSD.transfer(0x9f…, 50)", rule: "deny: token transfer from keeper", id: "pol_deny_7f2a" },
    { t: now - 25 * H, wallet: "keeper-1", action: "personal_sign", rule: "deny: message signing", id: "pol_deny_7f2b" },
  ],
  kimi: [{ t: now - 4 * H, leader: MOCK_LEADERS[0].name, nonce: "k3-6f1c2a", sigHash: "0x5ab1…e09c", verified: true }],
};
