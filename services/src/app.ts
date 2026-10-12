import { Hono } from "hono";
import { cors } from "hono/cors";
import { attest } from "./attest.js";
import { type FollowerParams, type MandateParams, backtest } from "./backtest.js";
import { computeFeatures } from "./features.js";
import { analyzeLeader } from "./kimi.js";
import { type LeaderData, fetchEnvioAccounts, fetchLeaderboard, getLeaderData } from "./leaderData.js";
import { NansenUnavailable, alignmentScore, compositeScore, discoverLeaders, exposureByMarket, fetchMonadNetflow, nansenClient } from "./nansen.js";
import { simulate } from "./simulate.js";
import { x402Seller } from "./x402seller.js";
import { type Fetch, ServiceUnavailable, env, isAddress } from "./util.js";

export const DEFAULT_FOLLOWER: FollowerParams = { depositCNS: 100, ratioBps: 200, maxNotionalCNS: 300, maxLeverageHdths: 500, maxChaseBps: 100, priceBandBps: 50, stopLossBps: 0 };
export const DEFAULT_MANDATE: MandateParams = { maxDDbps: 1500, epochLen: 7 * 86400 };

class BadRequest extends Error {}

/** Leader capital for the unit price: Perpl ROI base if known, else the largest fill notional (>= 100). */
export const leaderCapital = (d: LeaderData) => d.capitalEstimate ?? Math.max(100, ...d.fills.map((x) => x.notional));

export function createApp(deps: { fetch?: Fetch; now?: () => number } = {}) {
  const app = new Hono();
  const f = deps.fetch;
  const now = () => deps.now?.() ?? Math.floor(Date.now() / 1000);
  const addr = (a: string) => {
    if (!isAddress(a)) throw new BadRequest("invalid address");
    return a.toLowerCase();
  };
  const leader = (a: string, days = 30) => {
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new BadRequest("days must be an integer 1..365");
    return getLeaderData(addr(a), { days, now: now(), fetch: f });
  };
  // ~20 s LLM call: one per address+window per instance per hour (the CDN in api/index.js caches across instances).
  // ponytail: unbounded Map pruned on insert; fine for a per-instance memo of a few hundred leaders.
  const ANALYSIS_TTL_MS = 3600_000;
  const analysisMemo = new Map<string, { at: number; p: Promise<unknown> }>();
  const runAnalysis = async (a: string, days: number) => {
    const d = await leader(a, days);
    // the replay needs at least one closed round trip; an open-only history would "backtest" a single entry
    const bt = d.closedTrades.length ? backtest(d.fills, DEFAULT_FOLLOWER, DEFAULT_MANDATE, { leaderCapitalCNS: leaderCapital(d), from: d.window.from, to: d.window.to }).summary : undefined;
    const features = computeFeatures(d.fills, d.closedTrades, d.stats, { now: d.window.to, capital: d.capitalEstimate, backtest: bt, openPositions: d.openPositions });
    try {
      return await analyzeLeader(d.address, features, { fetch: f, now: now() });
    } catch (e) {
      if (e instanceof ServiceUnavailable) Object.assign(e, { features });
      throw e;
    }
  };

  app.use("*", cors());
  app.onError((e, c) => {
    if (e instanceof ServiceUnavailable) return c.json({ error: e.message, missing: e.missing }, 503);
    if (e instanceof BadRequest || e instanceof SyntaxError) return c.json({ error: e.message }, 400);
    return c.json({ error: e.message }, 502);
  });

  // D4 seller side: agents pay per call in Monad testnet USDC, settled by the Monad x402 facilitator (X402_PAY_TO turns it on)
  const seller = x402Seller();
  if (seller) {
    app.use("/x402/*", seller.middleware);
    app.get("/x402/report/:addr", async (c) => {
      const a = addr(c.req.param("addr"));
      const [attestation, analysis] = await Promise.all([attest(a, { fetch: f, now: now() }), runAnalysis(a, 30).catch((e) => ({ error: (e as Error).message }))]);
      return c.json({ attestation, analysis, paidWith: seller.terms });
    });
  }

  app.get("/", (c) => c.json({ service: "@copas/services", routes: ["/leader/:addr/stats", "POST /leader/:addr/backtest", "/leader/:addr/analysis", "/leader/:addr/alignment", "/discover", "POST /simulate", "/attest/:addr", ...(seller ? ["GET /x402/report/:addr (x402, Monad testnet USDC)"] : [])] }));

  app.get("/leader/:addr/stats", async (c) => {
    const d = await leader(c.req.param("addr"), Number(c.req.query("days") ?? 30));
    const { fills, ...rest } = d;
    return c.json(c.req.query("fills") ? d : { ...rest, fillsCount: fills.length });
  });

  app.post("/leader/:addr/backtest", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { follower?: Partial<FollowerParams>; mandate?: Partial<MandateParams>; opts?: any; days?: number };
    const d = await leader(c.req.param("addr"), body.days ?? 30);
    if (!d.fills.length) throw new BadRequest("leader has no fills in the window");
    if (!d.closedTrades.length)
      return c.json(
        {
          error: "not enough closed trades to backtest: a replay needs at least 1 closed round trip",
          activity: d.activity,
          fills: d.fills.length,
          closedTrades: 0,
          openPositions: d.openPositions,
        },
        422,
      );
    try {
      return c.json(backtest(d.fills, { ...DEFAULT_FOLLOWER, ...body.follower }, { ...DEFAULT_MANDATE, ...body.mandate }, { leaderCapitalCNS: leaderCapital(d), from: d.window.from, to: d.window.to, ...body.opts }));
    } catch (e) {
      throw new BadRequest((e as Error).message);
    }
  });

  app.get("/leader/:addr/analysis", async (c) => {
    const a = addr(c.req.param("addr"));
    const days = Number(c.req.query("days") ?? 30);
    const key = `${a}:${days}`;
    const t = Date.now();
    let m = analysisMemo.get(key);
    if (!m || t - m.at > ANALYSIS_TTL_MS) {
      for (const [k, v] of analysisMemo) if (t - v.at > ANALYSIS_TTL_MS) analysisMemo.delete(k);
      const entry = { at: t, p: runAnalysis(a, days) };
      entry.p.catch(() => analysisMemo.get(key) === entry && analysisMemo.delete(key)); // errors are never memoized
      analysisMemo.set(key, entry);
      m = entry;
    }
    try {
      return c.json((await m.p) as object);
    } catch (e) {
      if (e instanceof ServiceUnavailable) return c.json({ error: e.message, missing: e.missing, features: (e as any).features }, 503);
      throw e;
    }
  });

  app.get("/leader/:addr/alignment", async (c) => {
    const d = await leader(c.req.param("addr"));
    const nc = nansenClient({ fetch: f });
    const days = Number(c.req.query("days") ?? 7);
    const win = { from: d.window.to - days * 86400, to: d.window.to };
    // out of credits: still 200, so the badge degrades; the error stays visible in the JSON
    let netflow = null;
    let error: string | undefined;
    try {
      netflow = await fetchMonadNetflow(nc);
    } catch (e) {
      if (!(e instanceof NansenUnavailable)) throw e;
      error = e.message;
    }
    const alignment = netflow
      ? alignmentScore(exposureByMarket(d.fills, win.from, win.to), netflow, win)
      : { score: null, coverage: 0, markets: [], window: { ...win, netflowField: "net_flow_7d_usd" as const }, poweredBy: null };
    const composite = compositeScore({
      roi30d: d.official30d?.roi ?? null,
      winRate: d.stats.closedTrades ? d.stats.winRate : null,
      maxDrawdownPct: d.capitalEstimate ? (d.stats.maxDrawdown / d.capitalEstimate) * 100 : null,
      avgLeverage: d.stats.avgLeverage,
      alignment: alignment.score,
    });
    return c.json({ address: d.address, alignment, composite, cost: nc.ledger.toJSON(), ...(error ? { unavailable: "nansen-credits", error } : {}) });
  });

  app.get("/discover", async (c) => {
    const nc = nansenClient({ fetch: f });
    const board = await fetchLeaderboard("month", "pnl", f);
    const envio = env("ENVIO_GRAPHQL_URL");
    const accounts = envio ? (xs: string[]) => fetchEnvioAccounts(envio, xs, f) : undefined;
    return c.json(await discoverLeaders(nc, board, { limit: Math.min(25, Number(c.req.query("limit") ?? 10)), now: now(), accounts }));
  });

  app.post("/simulate", async (c) => {
    const tx = await c.req.json();
    if (!isAddress(tx?.from ?? "") || !isAddress(tx?.to ?? "")) throw new BadRequest("from/to must be addresses");
    return c.json(await simulate(tx, { fetch: f }));
  });

  app.get("/attest/:addr", async (c) => c.json(await attest(addr(c.req.param("addr")), { fetch: f, now: now() })));

  return app;
}
