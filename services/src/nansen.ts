/**
 * D2/D4 Nansen discovery + smart-money alignment. See NANSEN.md for every endpoint and why.
 *
 * Payment modes:
 *  - API key: header `apikey: $NANSEN_API_KEY` (OpenAPI securityScheme ApiKeyAuth). Cost = X-Nansen-Credits-Cost.
 *  - x402: USDC on Monad (eip155:143) via @x402/fetch + viem account from X402_PRIVATE_KEY. The client signs the
 *    x402 V2 payload and retries with the `PAYMENT-SIGNATURE` header. Cost = `amount` of the Monad option in the
 *    402 `payment-required` header (USDC, 6 decimals); settlement tx from the `payment-response` header.
 * Redistribution: outputs are composite scores and agree/disagree flags only — never raw holdings or flow sizes.
 */
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { type EnvioAccount, type Fill, type LeaderboardRow } from "./leaderData.js";
import { type Fetch, ServiceUnavailable, env, round, sum } from "./util.js";

export const NANSEN_API = "https://api.nansen.ai/api/v1";
export const MONAD_X402_NETWORK = "eip155:143";
export const POWERED_BY = "Powered by Nansen";

/** Nansen refused for money reasons (402/403, "Insufficient credits"). Callers degrade instead of failing. */
export class NansenUnavailable extends Error {
  reason = "nansen-credits" as const;
}

export interface NansenCall {
  endpoint: string;
  mode: "apikey" | "x402";
  credits?: number;
  usd?: number;
  paymentTx?: string;
}
export class CostLedger {
  calls: NansenCall[] = [];
  get totalUsd() {
    return round(sum(this.calls.map((c) => c.usd ?? 0)), 6);
  }
  get totalCredits() {
    return sum(this.calls.map((c) => c.credits ?? 0));
  }
  toJSON() {
    return { calls: this.calls, totalUsd: this.totalUsd, totalCredits: this.totalCredits };
  }
}

export function paymentMode(): "apikey" | "x402" {
  const want = env("NANSEN_PAYMENT_MODE");
  if (want === "x402" ? env("X402_PRIVATE_KEY") : want === "apikey" ? env("NANSEN_API_KEY") : false) return want as "apikey" | "x402";
  if (env("NANSEN_API_KEY")) return "apikey";
  if (env("X402_PRIVATE_KEY")) return "x402";
  throw new ServiceUnavailable("NANSEN_API_KEY or X402_PRIVATE_KEY", "Nansen needs NANSEN_API_KEY (credits) or X402_PRIVATE_KEY (USDC on Monad)");
}

/** USD price of the Monad USDC option in a base64 `payment-required` header (x402 V2). */
export function monadPriceUsd(paymentRequiredB64: string | null): number | undefined {
  if (!paymentRequiredB64) return undefined;
  const pr = JSON.parse(Buffer.from(paymentRequiredB64, "base64").toString("utf8"));
  const opt = pr.accepts?.find((a: any) => a.network === MONAD_X402_NETWORK);
  return opt ? Number(opt.amount) / 1e6 : undefined;
}

export interface NansenClient {
  post<T = any>(path: string, body: object): Promise<T>;
  ledger: CostLedger;
}

export function nansenClient(opts: { fetch?: Fetch; mode?: "apikey" | "x402" } = {}): NansenClient {
  const base = opts.fetch ?? fetch;
  const mode = opts.mode ?? paymentMode();
  const ledger = new CostLedger();
  let lastPrice: number | undefined;
  let paidFetch: Fetch | undefined;
  if (mode === "x402") {
    const key = env("X402_PRIVATE_KEY");
    if (!key) throw new ServiceUnavailable("X402_PRIVATE_KEY");
    const client = new x402Client();
    registerExactEvmScheme(client, { signer: privateKeyToAccount(key as `0x${string}`), networks: [MONAD_X402_NETWORK] });
    // spy on the 402 to learn the price we're about to pay
    const spy: Fetch = async (i, init) => {
      const r = await base(i, init);
      if (r.status === 402) lastPrice = monadPriceUsd(r.headers.get("payment-required"));
      return r;
    };
    paidFetch = wrapFetchWithPayment(spy, client) as Fetch;
  }
  return {
    ledger,
    async post(path, body) {
      const url = `${NANSEN_API}/${path}`;
      const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
      let r: Response;
      if (mode === "apikey") {
        (init.headers as Record<string, string>).apikey = env("NANSEN_API_KEY")!;
        r = await base(url, init);
      } else {
        lastPrice = undefined;
        r = await paidFetch!(url, init);
      }
      if (!r.ok) {
        const text = (await r.text()).slice(0, 200);
        const msg = `nansen ${path} ${r.status}: ${text}`;
        throw r.status === 402 || r.status === 403 || /credit/i.test(text) ? new NansenUnavailable(msg) : new Error(msg);
      }
      const call: NansenCall = { endpoint: path, mode };
      if (mode === "apikey") call.credits = Number(r.headers.get("x-nansen-credits-cost") ?? 0) || undefined;
      else {
        call.usd = lastPrice;
        const pr = r.headers.get("payment-response");
        if (pr) call.paymentTx = (decodePaymentResponseHeader(pr) as any)?.transaction;
      }
      ledger.calls.push(call);
      return r.json();
    },
  };
}

// ------------------------------------------------------------------ smart-money alignment (D2 b)

/** Perpl market -> Monad token symbols whose smart-money netflow speaks for it. */
export const MARKET_TOKENS: Record<string, string[]> = {
  BTC: ["WBTC", "BTC", "CBBTC", "LBTC"],
  ETH: ["WETH", "ETH"],
  MON: ["MON", "WMON", "SMON", "GMON", "SHMON", "APRMON"],
  SOL: ["SOL", "WSOL"],
};

export interface NetflowRow {
  token_symbol: string;
  net_flow_24h_usd: number;
  net_flow_7d_usd: number;
}

/** Time-weighted signed notional per market over [from, to] from the leader's position path. */
export function exposureByMarket(fills: Fill[], from: number, to: number): Map<string, number> {
  const out = new Map<string, number>();
  const state = new Map<number, { pos: number; price: number; t: number; sym: string }>();
  const add = (sym: string, v: number) => out.set(sym, (out.get(sym) ?? 0) + v);
  for (const x of fills) {
    if (x.ts > to) break;
    const s = state.get(x.market);
    if (s && x.ts > from) add(s.sym, s.pos * s.price * (x.ts - Math.max(s.t, from)));
    state.set(x.market, { pos: x.positionAfter, price: x.price, t: x.ts, sym: x.symbol });
  }
  for (const s of state.values()) if (to > from) add(s.sym, s.pos * s.price * (to - Math.max(s.t, from)));
  for (const [k, v] of out) out.set(k, v / Math.max(1, to - from));
  return out;
}

export interface Alignment {
  score: number | null; // 0..100: share of exposure that agrees with Monad smart-money netflow
  coverage: number; // share of the leader's exposure in markets that have Monad smart-money data
  markets: { market: string; leaderDirection: "long" | "short"; smartMoneyDirection: "inflow" | "outflow" | "none"; agrees: boolean | null }[];
  window: { from: number; to: number; netflowField: "net_flow_7d_usd" | "net_flow_24h_usd" };
  poweredBy: string | null;
}

export function alignmentScore(exposure: Map<string, number>, netflow: NetflowRow[], window: { from: number; to: number }, field: "net_flow_7d_usd" | "net_flow_24h_usd" = "net_flow_7d_usd"): Alignment {
  const flow = (mkt: string) => {
    const syms = MARKET_TOKENS[mkt];
    if (!syms) return null;
    const rows = netflow.filter((r) => syms.includes(String(r.token_symbol).toUpperCase()));
    return rows.length ? sum(rows.map((r) => Number(r[field]) || 0)) : null;
  };
  let total = 0;
  let covered = 0;
  let agree = 0;
  const markets: Alignment["markets"] = [];
  for (const [mkt, e] of exposure) {
    if (!e) continue;
    total += Math.abs(e);
    const fl = flow(mkt);
    const sm = fl == null || fl === 0 ? "none" : fl > 0 ? "inflow" : "outflow";
    const ok = sm === "none" ? null : (e > 0) === (sm === "inflow");
    if (ok != null) {
      covered += Math.abs(e);
      if (ok) agree += Math.abs(e);
    }
    markets.push({ market: mkt, leaderDirection: e > 0 ? "long" : "short", smartMoneyDirection: sm, agrees: ok });
  }
  return { score: covered ? round((agree / covered) * 100, 1) : null, coverage: total ? round(covered / total, 3) : 0, markets, window: { ...window, netflowField: field }, poweredBy: POWERED_BY };
}

/** Monad smart-money netflow is the same for every leader: one paid call per instance per hour. */
export const NETFLOW_TTL_MS = 3_600_000;
let netflowCache: { at: number; rows: NetflowRow[] } | null = null;
export const clearNetflowCache = () => void (netflowCache = null);

export async function fetchMonadNetflow(c: NansenClient, nowMs = Date.now()): Promise<NetflowRow[]> {
  if (netflowCache && nowMs - netflowCache.at < NETFLOW_TTL_MS) return netflowCache.rows;
  const j = await c.post<{ data: NetflowRow[] }>("smart-money/netflow", {
    chains: ["monad"],
    filters: { include_native_tokens: true, include_stablecoins: false },
    pagination: { page: 1, per_page: 100 },
  });
  netflowCache = { at: nowMs, rows: j.data ?? [] };
  return netflowCache.rows;
}

// ------------------------------------------------------------------ composite score (D2 c)

export interface Composite {
  score: number | null; // 0..100, null when no component has data
  components: { performance?: number; risk?: number; smartMoneyAlignment?: number; nansenWalletQuality?: number };
  weights: Record<string, number>;
  poweredBy: string | null; // only when a Nansen-derived component is in the score
}
const W = { performance: 0.4, risk: 0.3, smartMoneyAlignment: 0.2, nansenWalletQuality: 0.1 };
const clamp = (x: number) => Math.max(0, Math.min(100, x));

/** Missing components are dropped and the weights renormalized. Inputs are already-derived numbers, never raw Nansen rows. */
export function compositeScore(c: { performance?: number | null; roi30d?: number | null; winRate?: number | null; maxDrawdownPct?: number | null; avgLeverage?: number | null; alignment?: number | null; nansenWinRate?: number | null; nansenRealizedPnlUsd?: number | null }): Composite {
  const comp: Composite["components"] = {};
  if (c.performance != null) comp.performance = round(clamp(c.performance), 1);
  else if (c.roi30d != null) comp.performance = round(clamp(50 + c.roi30d * 100) * (c.winRate != null ? 0.7 + 0.3 * c.winRate : 1), 1);
  if (c.maxDrawdownPct != null || c.avgLeverage != null) comp.risk = round(clamp(100 - (c.maxDrawdownPct ?? 0) * 2 - Math.max(0, (c.avgLeverage ?? 0) - 3) * 4), 1);
  if (c.alignment != null) comp.smartMoneyAlignment = c.alignment;
  if (c.nansenWinRate != null) comp.nansenWalletQuality = round(clamp(c.nansenWinRate * 100 * ((c.nansenRealizedPnlUsd ?? 0) >= 0 ? 1 : 0.6)), 1);
  const keys = Object.keys(comp) as (keyof typeof W)[];
  const wsum = sum(keys.map((k) => W[k]));
  const score = wsum ? round(sum(keys.map((k) => comp[k]! * W[k])) / wsum, 1) : null;
  const nansen = comp.smartMoneyAlignment != null || comp.nansenWalletQuality != null;
  return { score, components: comp, weights: Object.fromEntries(keys.map((k) => [k, round(W[k] / wsum, 3)])), poweredBy: nansen ? POWERED_BY : null };
}

// ------------------------------------------------------------------ discovery (D2 a)

export interface Candidate {
  address: string;
  smartMoney: boolean; // seen in Nansen smart-money DEX trades on Monad
  perpl: { rank: number; pnl30d: number; roi30d: number; volume30d: number };
  composite: Composite;
}

/** 0..1 position of x among xs (ties share the lower rank; a single value is 1). */
const rankPct = (x: number, xs: number[]) => (xs.length > 1 ? xs.filter((y) => y < x).length / (xs.length - 1) : 1);

export async function discoverLeaders(
  c: NansenClient,
  board: LeaderboardRow[],
  opts: { limit?: number; now?: number; accounts?: (addresses: string[]) => Promise<Map<string, EnvioAccount>> } = {},
) {
  const limit = opts.limit ?? 10;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const active = board.filter((r) => r.volume > 0);
  let nansenError: string | null = null;
  const degrade = (e: unknown) => {
    if (!(e instanceof NansenUnavailable)) throw e;
    nansenError = e.message;
  };
  // 1) Monad smart-money traders (addresses only; trade rows are not returned to the client)
  const sm = new Set<string>();
  try {
    for (let page = 1; page <= 2; page++) {
      const j = await c.post<{ data: { trader_address: string }[]; pagination?: { is_last_page?: boolean } }>("smart-money/dex-trades", {
        chains: ["monad"],
        pagination: { page, per_page: 100 },
      });
      for (const t of j.data ?? []) if (t.trader_address) sm.add(t.trader_address.toLowerCase());
      if (j.pagination?.is_last_page !== false) break;
    }
  } catch (e) {
    degrade(e);
  }
  // 2) intersect with active Perpl traders; fill up with the best Perpl traders (by 30d PnL, positive ROI)
  const overlap = active.filter((r) => sm.has(r.address));
  const rest = active.filter((r) => !sm.has(r.address) && r.pnl > 0 && r.roi > 0).sort((a, b) => b.pnl - a.pnl);
  const picked = [...overlap, ...rest].slice(0, limit);
  // 3) risk + win rate from the indexer's all-time Account aggregates (one query for all candidates)
  const none = new Map<string, EnvioAccount>();
  const accounts = opts.accounts ? await opts.accounts(picked.map((r) => r.address)).catch(() => none) : none;
  const rois = picked.map((r) => r.roi);
  const pnls = picked.map((r) => r.pnl);
  // 4) Nansen profiler on Monad for wallet quality (spot PnL / win rate on Monad)
  const date = { from: new Date((now - 30 * 86400) * 1000).toISOString().slice(0, 10), to: new Date(now * 1000).toISOString().slice(0, 10) };
  const out: Candidate[] = [];
  for (const r of picked) {
    let q: { win_rate?: number; realized_pnl_usd?: number } | null = null;
    if (!nansenError) {
      try {
        q = await c.post("profiler/address/pnl-summary", { address: r.address, chain: "monad", date });
      } catch (e) {
        degrade(e); // credits gone: stop paying for the rest; anything else = no Monad history, component dropped
      }
    }
    const a = accounts.get(r.address);
    const winRate = a?.closedTrades ? a.wins / a.closedTrades : null;
    const cap = r.roi > 0 && r.pnl > 0 ? r.pnl / r.roi : null;
    out.push({
      address: r.address,
      smartMoney: sm.has(r.address),
      perpl: { rank: r.rank, pnl30d: r.pnl, roi30d: r.roi, volume30d: r.volume },
      composite: compositeScore({
        // relative to the other candidates, so the ranking spreads instead of every top trader capping at 100
        performance: 100 * (0.5 * rankPct(r.roi, rois) + 0.5 * rankPct(r.pnl, pnls)) * (winRate != null ? 0.7 + 0.3 * winRate : 1),
        // ponytail: all-time realized max drawdown over the 30d Perpl ROI capital; a per-window DD needs every candidate's fills
        maxDrawdownPct: a && cap ? (Number(a.maxDrawdownCNS) / 1e6 / cap) * 100 : null,
        nansenWinRate: q?.win_rate ?? null,
        nansenRealizedPnlUsd: q?.realized_pnl_usd ?? null,
      }),
    });
  }
  out.sort((a, b) => Number(b.smartMoney) - Number(a.smartMoney) || (b.composite.score ?? -1) - (a.composite.score ?? -1));
  const usedNansen = sm.size > 0 || out.some((x) => x.composite.poweredBy);
  return {
    candidates: out,
    smartMoneyOverlap: overlap.length,
    smartMoneyWalletsSeen: sm.size,
    activePerplTraders: active.length,
    nansen: { available: !nansenError, error: nansenError as string | null },
    ...(nansenError ? { unavailable: "nansen-credits" as const } : {}),
    cost: c.ledger.toJSON(),
    poweredBy: usedNansen ? POWERED_BY : null,
  };
}
