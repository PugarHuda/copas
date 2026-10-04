import { Hono } from "hono";
import { cors } from "hono/cors";
import { attest } from "./attest.js";
import { type FollowerParams, type MandateParams, backtest } from "./backtest.js";
import { computeFeatures } from "./features.js";
import { analyzeLeader, verifyKimiSignature } from "./kimi.js";
import { type LeaderData, fetchLeaderboard, getLeaderData } from "./leaderData.js";
import { alignmentScore, compositeScore, discoverLeaders, exposureByMarket, fetchMonadNetflow, nansenClient } from "./nansen.js";
import { simulate } from "./simulate.js";
import { type Fetch, ServiceUnavailable, isAddress } from "./util.js";

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
  const leader = (a: string, days = 30) => getLeaderData(addr(a), { days, now: now(), fetch: f });

  app.use("*", cors());
  app.onError((e, c) => {
    if (e instanceof ServiceUnavailable) return c.json({ error: e.message, missing: e.missing }, 503);
    if (e instanceof BadRequest || e instanceof SyntaxError) return c.json({ error: e.message }, 400);
    return c.json({ error: e.message }, 502);
  });

  app.get("/", (c) => c.json({ service: "@copas/services", routes: ["/leader/:addr/stats", "POST /leader/:addr/backtest", "/leader/:addr/analysis", "/leader/:addr/alignment", "/discover", "POST /simulate", "/attest/:addr", "POST /kimi/verify"] }));

  app.get("/leader/:addr/stats", async (c) => {
    const d = await leader(c.req.param("addr"), Number(c.req.query("days") ?? 30));
    const { fills, ...rest } = d;
    return c.json(c.req.query("fills") ? d : { ...rest, fillsCount: fills.length });
  });

  app.post("/leader/:addr/backtest", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { follower?: Partial<FollowerParams>; mandate?: Partial<MandateParams>; opts?: any; days?: number };
    const d = await leader(c.req.param("addr"), body.days ?? 30);
    if (!d.fills.length) throw new BadRequest("leader has no fills in the window");
    try {
      return c.json(backtest(d.fills, { ...DEFAULT_FOLLOWER, ...body.follower }, { ...DEFAULT_MANDATE, ...body.mandate }, { leaderCapitalCNS: leaderCapital(d), from: d.window.from, to: d.window.to, ...body.opts }));
    } catch (e) {
      throw new BadRequest((e as Error).message);
    }
  });

  app.get("/leader/:addr/analysis", async (c) => {
    const d = await leader(c.req.param("addr"));
    const bt = d.fills.length ? backtest(d.fills, DEFAULT_FOLLOWER, DEFAULT_MANDATE, { leaderCapitalCNS: leaderCapital(d), from: d.window.from, to: d.window.to }).summary : undefined;
    const features = computeFeatures(d.fills, d.closedTrades, d.stats, { now: d.window.to, capital: d.capitalEstimate, backtest: bt });
    try {
      return c.json(await analyzeLeader(d.address, features, { fetch: f, now: now() }));
    } catch (e) {
      if (e instanceof ServiceUnavailable) return c.json({ error: e.message, missing: e.missing, features }, 503);
      throw e;
    }
  });

  app.get("/leader/:addr/alignment", async (c) => {
    const d = await leader(c.req.param("addr"));
    const nc = nansenClient({ fetch: f });
    const days = Number(c.req.query("days") ?? 7);
    const win = { from: d.window.to - days * 86400, to: d.window.to };
    const alignment = alignmentScore(exposureByMarket(d.fills, win.from, win.to), await fetchMonadNetflow(nc), win);
    const composite = compositeScore({
      roi30d: d.official30d?.roi ?? null,
      winRate: d.stats.closedTrades ? d.stats.winRate : null,
      maxDrawdownPct: d.capitalEstimate ? (d.stats.maxDrawdown / d.capitalEstimate) * 100 : null,
      avgLeverage: d.stats.avgLeverage,
      alignment: alignment.score,
    });
    return c.json({ address: d.address, alignment, composite, cost: nc.ledger.toJSON() });
  });

  app.get("/discover", async (c) => {
    const nc = nansenClient({ fetch: f });
    const board = await fetchLeaderboard("month", "pnl", f);
    return c.json(await discoverLeaders(nc, board, { limit: Math.min(25, Number(c.req.query("limit") ?? 10)), now: now() }));
  });

  app.post("/simulate", async (c) => {
    const tx = await c.req.json();
    if (!isAddress(tx?.from ?? "") || !isAddress(tx?.to ?? "")) throw new BadRequest("from/to must be addresses");
    return c.json(await simulate(tx, { fetch: f }));
  });

  app.get("/attest/:addr", async (c) => c.json(await attest(addr(c.req.param("addr")), { fetch: f, now: now() })));

  app.post("/kimi/verify", async (c) => c.json({ valid: await verifyKimiSignature(await c.req.json(), f) }));

  return app;
}
