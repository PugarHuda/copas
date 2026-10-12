import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attest, buildTrackRecord, signTrackRecord, verifyAttestation } from "../src/attest.js";
import { backtest } from "../src/backtest.js";
import { computeFeatures } from "../src/features.js";
import { analyzeLeader, guardAnalysis, humanize, kimiCost } from "../src/kimi.js";
import { type Fill, closedTrades, getLeaderData, normalizePlumbRow } from "../src/leaderData.js";
import { alignmentScore, clearNetflowCache, compositeScore, discoverLeaders, exposureByMarket, fetchMonadNetflow, monadPriceUsd, nansenClient } from "../src/nansen.js";
import { simulate } from "../src/simulate.js";
import { createApp } from "../src/app.js";
import { LEADER, NOW, calls, nansen, nansen402, stubFetch, trades } from "./stub.js";

// The Kimi-path tests must not pick up a developer machine's global OpenRouter key.
delete process.env.OPENROUTER_API_KEY;

const KEYS = ["KIMI_API_KEY", "NANSEN_API_KEY", "X402_PRIVATE_KEY", "NANSEN_PAYMENT_MODE", "ATTESTER_PRIVATE_KEY", "TENDERLY_ACCESS_KEY", "TENDERLY_ACCOUNT", "TENDERLY_PROJECT", "ENVIO_GRAPHQL_URL", "KIMI_LOG_PATH"];
const TEST_PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil #1, test only
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  clearNetflowCache();
});
afterEach(() => {
  for (const k of KEYS) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});

const fill = (ts: number, buy: boolean, price: number, size: number, positionAfter: number, pnl = 0, fee = 0, leverage: number | null = 5): Fill => ({
  ts, block: ts, logIndex: 0, tx: "0x", market: 1, symbol: "BTC", buy, price, size, notional: price * size, fee, pnl, role: "taker", kind: "x", positionAfter, leverage,
});

describe("leaderData", () => {
  it("normalizes plumb rows (sign from side, invert keeps the new side)", () => {
    const inv = trades().find((r) => r.kind === "invert");
    const f = normalizePlumbRow(inv);
    expect(f.positionAfter).toBe(inv.side === "long" ? Number(inv.remaining) : -Number(inv.remaining));
    expect(f.symbol).not.toMatch(/_v\d/);
  });

  it("builds round trips and stats from the recorded wallet", async () => {
    const d = await getLeaderData(LEADER, { days: 90, now: NOW, fetch: stubFetch });
    expect(d.source).toBe("plumb");
    expect(d.fills.length).toBeGreaterThan(100);
    expect(d.official30d?.rank).toBe(18);
    expect(d.capitalEstimate).toBeGreaterThan(1000);
    // every closed trade's net pnl adds up to the realized curve of fully-closed trips
    const t = d.closedTrades;
    expect(t.length).toBeGreaterThan(20);
    expect(t.every((x) => x.closedAt >= x.openedAt)).toBe(true);
    expect(d.stats.wins).toBe(t.filter((x) => x.win).length);
    expect(d.stats.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(d.equityCurve.at(-1)!.cumNetPnl).toBeCloseTo(d.stats.netPnl, 4);
  });

  it("splits an invert into a closed trip and a new one", () => {
    const xs = [fill(1, true, 100, 1, 1), fill(2, false, 110, 2, -1, 10), fill(3, true, 105, 1, 0, 5)];
    const t = closedTrades(xs);
    expect(t.map((x) => [x.side, x.netPnl])).toEqual([["long", 10], ["short", 5]]);
  });
});

describe("backtest (C3)", () => {
  const follower = { depositCNS: 1000, ratioBps: 10_000, maxNotionalCNS: 1000, maxLeverageHdths: 1000, maxChaseBps: 2000, priceBandBps: 100, stopLossBps: 0 };
  const zero = { halfSpreadBps: 0, driftBpsPerBlock: 0, takerFeeBps: 0 };

  it("breach on drawdown pays min(pro-rata pot, loss) exactly like LeaderBook.claimFor", () => {
    const xs = [fill(10, true, 100, 1, 1), fill(20, false, 90, 1, 0, -10)];
    const r = backtest(xs, follower, { maxDDbps: 500, epochLen: 1000 }, { leaderCapitalCNS: 100, ...zero });
    expect(r.epochs).toHaveLength(1);
    expect(r.epochs[0]).toMatchObject({ breached: true, breachReason: "Drawdown", pot: 100, followerLoss: 10, compensation: 10 });
    expect(r.summary.netPnl).toBeCloseTo(-10, 9);
    expect(r.summary.netPnlWithCompensation).toBeCloseTo(0, 9);
  });

  it("charges taker fees on both sides and adverse slippage", () => {
    const xs = [fill(10, true, 100, 1, 1), fill(20, false, 100, 1, 0)];
    const r = backtest(xs, follower, { maxDDbps: 5000, epochLen: 1000 }, { leaderCapitalCNS: 1000, halfSpreadBps: 2, latencyBlocks: 2, driftBpsPerBlock: 1 });
    expect(r.summary.fees).toBeCloseTo(100 * 1.0004 * 0.000345 + 100 * 0.9996 * 0.000345, 6);
    expect(r.summary.slippageCost).toBeCloseTo(0.08, 6);
    expect(r.summary.netPnl).toBeLessThan(0);
  });

  it("refuses to chase, respects the notional cap and the price band", () => {
    const xs = [fill(10, true, 100, 1, 1), fill(11, true, 120, 1, 2), fill(20, false, 120, 2, 0, 20)];
    const capped = backtest(xs, { ...follower, maxNotionalCNS: 50, maxChaseBps: 500 }, { maxDDbps: 5000, epochLen: 1000 }, { leaderCapitalCNS: 1000, ...zero });
    expect(capped.summary.skippedChase).toBe(0); // already at the 0.5 lot cap
    const chase = backtest(xs, { ...follower, maxChaseBps: 500 }, { maxDDbps: 5000, epochLen: 1000 }, { leaderCapitalCNS: 1000, ...zero });
    expect(chase.summary.skippedChase).toBe(1);
    const band = backtest(xs, { ...follower, priceBandBps: 1 }, { maxDDbps: 5000, epochLen: 1000 }, { leaderCapitalCNS: 1000, halfSpreadBps: 5 });
    expect(band.summary.copiedFills).toBe(0);
  });

  it("is deterministic on the recorded leader and keeps the claim invariants", async () => {
    const d = await getLeaderData(LEADER, { days: 90, now: NOW, fetch: stubFetch });
    const run = () => backtest(d.fills, { ...follower, depositCNS: 100, ratioBps: 200, maxNotionalCNS: 300, maxLeverageHdths: 500 }, { maxDDbps: 300, epochLen: 7 * 86400 }, { leaderCapitalCNS: d.capitalEstimate!, from: d.window.from, to: d.window.to });
    const a = run();
    expect(run()).toEqual(a);
    expect(a.summary.epochs).toBeGreaterThanOrEqual(12);
    expect(a.summary.copiedFills).toBeGreaterThan(0);
    for (const e of a.epochs) {
      expect(e.compensation).toBeLessThanOrEqual(e.pot + 1e-9);
      expect(e.compensation).toBeLessThanOrEqual(e.followerLoss + 1e-9);
      if (!e.breached) expect(e.compensation).toBe(0);
    }
    expect(a.assumptions.length).toBeGreaterThan(5);
  });
});

describe("features + Kimi (D1, D3)", () => {
  it("detects size-up after losses and ranks reasons deterministically", () => {
    // loss on 1 lot, then 3 lots; loss, then 6 lots
    const xs = [
      fill(0, true, 100, 1, 1), fill(100, false, 90, 1, 0, -10),
      fill(200, true, 100, 3, 3), fill(300, false, 95, 3, 0, -15),
      fill(400, true, 100, 6, 6), fill(500, false, 101, 6, 0, 6),
      fill(600, true, 100, 1, 1), fill(700, false, 99, 1, 0, -1),
    ];
    const t = closedTrades(xs);
    const stats = { ...baseStats, closedTrades: t.length, markets: [{ symbol: "BTC", trades: 4, netPnl: -20, share: 1 }], worstLosingStreak: 2, lastTradeAt: 700 };
    const f = computeFeatures(xs, t, stats, { now: 800, capital: 100 });
    expect(f.tilt.sizeUpsAfterLoss).toBe(2);
    expect(f.tilt.detected).toBe(true);
    expect(f.reasonsNotToFollow.map((r) => r.key)).toContain("tilt");
    expect(computeFeatures(xs, t, stats, { now: 800, capital: 100 })).toEqual(f);
  });

  it("guard overrides LLM flags and drops invented reasons", () => {
    const f = { tilt: { detected: false }, drift: { detected: true }, reasonsNotToFollow: [{ key: "small_sample", severity: 1, metric: "closedTrades", value: 3, detail: "d1" }, { key: "concentration", severity: 0.5, metric: "m", value: 1, detail: "d2" }, { key: "inactive", severity: 0.4, metric: "m2", value: 9, detail: "d3" }] } as any;
    const a = guardAnalysis({ riskLevel: "extreme", tilt: { detected: true }, devilsAdvocate: [{ key: "made_up" }, { key: "inactive", en: "x", id: "y" }] }, f);
    expect(a.tilt.detected).toBe(false);
    expect(a.drift.detected).toBe(true);
    expect(a.riskLevel).toBe("medium");
    expect(a.devilsAdvocate.map((d) => d.key)).toEqual(["inactive", "small_sample", "concentration"]);
  });

  it("prices usage at $3/$15 per 1M (cached input $0.30)", () => {
    expect(kimiCost({ prompt_tokens: 4000, completion_tokens: 1500, prompt_tokens_details: { cached_tokens: 1000 } }).costUsd).toBeCloseTo((3000 * 3 + 1000 * 0.3 + 1500 * 15) / 1e6, 9);
  });

  it("calls kimi-k3 with a nonce, verifies the signature and logs hashes", async () => {
    process.env.KIMI_API_KEY = "test";
    const logPath = join(mkdtempSync(join(tmpdir(), "kimi-")), "log.jsonl");
    const d = await getLeaderData(LEADER, { days: 90, now: NOW, fetch: stubFetch });
    const feats = computeFeatures(d.fills, d.closedTrades, d.stats, { now: NOW, capital: d.capitalEstimate });
    let sent: any;
    const spy: typeof fetch = async (u, init) => {
      if (String(u).endsWith("/chat/completions")) sent = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return stubFetch(u, init);
    };
    const r = await analyzeLeader(LEADER, feats, { fetch: spy, logPath, now: NOW });
    expect(sent.body.model).toBe("kimi-k3");
    expect(sent.body.reasoning_effort).toBe("high");
    expect(sent.body).not.toHaveProperty("temperature");
    expect(sent.headers.get("x-msh-request-nonce")).toBe(r.nonce);
    expect(r.signature).toMatchObject({ nonce: r.nonce, model: "kimi-k3", signature: "reqsigv1_fixture", timestamp: 1791043700000 });
    expect(r.signatureValid).toBe(true);
    expect(r.analysis.tilt.detected).toBe(feats.tilt.detected);
    expect(r.analysis.devilsAdvocate).toHaveLength(Math.min(3, feats.reasonsNotToFollow.length));
    expect(r.costUsd).toBeCloseTo(0.0318, 6);
    const line = JSON.parse(readFileSync(logPath, "utf8").trim());
    expect(line).toMatchObject({ nonce: r.nonce, inputHash: r.inputHash, outputHash: r.outputHash });
  });
});

describe("Nansen (D2, D4)", () => {
  it("reads the Monad USDC price from a live 402", () => {
    expect(nansen402.status).toBe(402);
    expect(monadPriceUsd(nansen402.paymentRequired)).toBe(0.05);
  });

  it("alignment = share of exposure agreeing with Monad smart-money netflow", () => {
    const exp = new Map([["BTC", 300], ["ETH", 100], ["ZEC", 50]]); // long BTC (inflow), long ETH (outflow), ZEC no data
    const a = alignmentScore(exp, nansen["smart-money/netflow"].data, { from: 0, to: 1 });
    expect(a.score).toBe(75);
    expect(a.coverage).toBeCloseTo(400 / 450, 3);
    expect(JSON.stringify(a)).not.toMatch(/180000|net_flow_7d_usd":\d/); // no raw flow sizes leak
  });

  it("time-weights exposure from the position path", () => {
    const e = exposureByMarket([fill(0, true, 100, 1, 1), fill(50, false, 100, 1, 0)], 0, 100);
    expect(e.get("BTC")).toBeCloseTo(50, 9);
  });

  it("API-key mode records credits; discovery intersects smart money with Perpl traders", async () => {
    process.env.NANSEN_API_KEY = "k";
    const c = nansenClient({ fetch: stubFetch });
    const board = (await (await stubFetch("https://app.perpl.xyz/api/v1/trading/leaderboard/month/pnl")).json()).d.map((r: any) => ({ rank: r.i, address: r.a, pnl: Number(r.p) / 1e6, roi: r.r / 1e4, volume: Number(r.v) / 1e6 }));
    const r = await discoverLeaders(c, board, { limit: 3, now: NOW });
    const scores = r.candidates.map((x) => x.composite.components.performance);
    expect(Math.max(...scores as number[]) - Math.min(...scores as number[])).toBeGreaterThanOrEqual(50); // normalized across candidates, not all 100
    expect(r.nansen.available).toBe(true);
    expect(r.smartMoneyOverlap).toBe(1);
    expect(r.candidates[0]).toMatchObject({ address: LEADER, smartMoney: true });
    expect(r.candidates[0].composite.components.nansenWalletQuality).toBe(55);
    expect(r.cost.totalCredits).toBe(5 + 3);
    expect(r.poweredBy).toBe("Powered by Nansen");
  });

  it("x402 mode pays USDC on Monad with the V2 PAYMENT-SIGNATURE header", async () => {
    process.env.X402_PRIVATE_KEY = TEST_PK;
    let paidHeaders: Headers | undefined;
    const spy: typeof fetch = async (u, init) => {
      const h = new Headers(init?.headers ?? (u instanceof Request ? u.headers : undefined));
      if (h.get("payment-signature")) paidHeaders = h;
      return stubFetch(u instanceof Request ? u.url : u, { ...init, headers: h, body: init?.body ?? (u instanceof Request ? await u.clone().text() : undefined) });
    };
    const c = nansenClient({ fetch: spy });
    const rows = await fetchMonadNetflow(c);
    expect(rows.length).toBe(3);
    expect(paidHeaders?.get("x-payment")).toBeNull();
    const payload = JSON.parse(Buffer.from(paidHeaders!.get("payment-signature")!, "base64").toString());
    expect(payload.x402Version).toBe(2);
    expect(payload.accepted.network).toBe("eip155:143");
    expect(c.ledger.toJSON()).toMatchObject({ totalUsd: 0.05, calls: [{ endpoint: "smart-money/netflow", mode: "x402", usd: 0.05 }] });
  });

  it("composite drops missing components and renormalizes", () => {
    const c = compositeScore({ roi30d: 0.2, winRate: 0.6, alignment: 80 });
    expect(Object.keys(c.weights).sort()).toEqual(["performance", "smartMoneyAlignment"]);
    expect(c.score).toBeGreaterThan(0);
  });
});

describe("simulate (C4) + attest (A7)", () => {
  it("uses Tenderly when configured", async () => {
    Object.assign(process.env, { TENDERLY_ACCESS_KEY: "k", TENDERLY_ACCOUNT: "a", TENDERLY_PROJECT: "p" });
    const r = await simulate({ from: "0x1111111111111111111111111111111111111111", to: "0x2222222222222222222222222222222222222222", data: "0x" }, { fetch: stubFetch });
    expect(r).toMatchObject({ engine: "tenderly", success: true, gasUsed: 412345 });
    expect(r.balanceChanges[0]).toMatchObject({ symbol: "AUSD", diff: "-100000000" });
    expect(r.events[0]).toMatchObject({ name: "Deposited" });
  });

  it("signs a canonical track record that verifies and breaks when tampered", async () => {
    process.env.ATTESTER_PRIVATE_KEY = TEST_PK;
    const a = await attest(LEADER, { fetch: stubFetch, now: NOW });
    const d = await getLeaderData(LEADER, { now: NOW, fetch: stubFetch });
    // one source of truth: the attested stats are the analysis stats (same fills, same 30d window)
    expect(a.record).toMatchObject({ closedTrades: d.stats.closedTrades, winRateBps: Math.round(d.stats.winRate * 10_000), complete: true, pnl30dSource: "fills", window: d.window });
    expect(a.record.closedTrades).toBeGreaterThan(5);
    expect(a.record.perplLeaderboard30d?.pnl).toBe("1364.371360");
    expect(await verifyAttestation(a)).toBe(true);
    expect(await verifyAttestation({ ...a, record: { ...a.record, pnl30d: "999999.000000" } })).toBe(false);
    const again = await signTrackRecord(buildTrackRecord(d));
    expect(again.hash).toBe(a.hash);
  });
});

describe("HTTP", () => {
  const app = createApp({ fetch: stubFetch, now: () => NOW });
  it("serves stats and backtest from fixtures", async () => {
    const s = await (await app.request(`/leader/${LEADER}/stats`)).json();
    expect(s.official30d.rank).toBe(18);
    const b = await app.request(`/leader/${LEADER}/backtest`, { method: "POST", body: JSON.stringify({ days: 90, mandate: { maxDDbps: 300 } }) });
    expect(b.status).toBe(200);
    expect((await b.json()).summary.epochs).toBeGreaterThan(10);
  });
  it("returns clear 503s when keys are missing", async () => {
    for (const p of [`/leader/${LEADER}/analysis`, `/leader/${LEADER}/alignment`, "/discover", `/attest/${LEADER}`]) {
      const r = await app.request(p);
      expect(r.status, p).toBe(503);
      expect((await r.json()).missing).toBeTruthy();
    }
    const a = await (await app.request(`/leader/${LEADER}/analysis`)).json();
    expect(a.features.reasonsNotToFollow).toBeDefined();
  });
  it("rejects bad addresses", async () => {
    expect((await app.request("/leader/0x123/stats")).status).toBe(400);
  });
  it("only calls fixtures (no network)", () => {
    expect(calls.every((u) => !u.startsWith("no fixture"))).toBe(true);
  });
});

const baseStats = { fills: 0, closedTrades: 0, wins: 0, winRate: 0, profitFactor: null, netPnl: 0, grossProfit: 0, grossLoss: 0, fees: 0, volume: 0, maxDrawdown: 20, avgHoldSeconds: 100, medianNotional: 300, avgLeverage: 5, tradesPerDay: 1, longShare: 1, markets: [], worstLosingStreak: 0, lastTradeAt: null };

describe("Envio source", () => {
  it("reads Fill entities from copas/indexer when ENVIO_GRAPHQL_URL is set", async () => {
    process.env.ENVIO_GRAPHQL_URL = "http://envio.test/v1/graphql";
    const market = { perpId: 1, symbol: "BTC", priceDecimals: 1, lotDecimals: 5 };
    const envioFetch: typeof fetch = async (u, init) => {
      if (!String(u).startsWith("http://envio.test")) return stubFetch(u, init);
      const q = JSON.parse(String(init?.body)).query as string;
      const data = q.includes("Protocol")
        ? { Protocol: [{ lastUpdatedAt: NOW - 60 }] }
        : q.includes("Account")
        ? { Account: [{ id: "3237", chainId: 143, fills: 2, closedTrades: 1, wins: 1, netPnlCNS: "9927550", maxDrawdownCNS: "0", firstSeenAt: NOW - 100, lastSeenAt: NOW - 50 }] }
        : { Fill: [
            { id: "100-1", timestamp: NOW - 100, block: 100, txHash: "0xa", role: "TAKER", side: "BUY", pricePNS: "1000000", lotLNS: "100000", notionalCNS: "100000000", feeCNS: "34500", realizedPnlCNS: "0", market },
            { id: "200-2", timestamp: NOW - 50, block: 200, txHash: "0xb", role: "TAKER", side: "SELL", pricePNS: "1100000", lotLNS: "100000", notionalCNS: "110000000", feeCNS: "37950", realizedPnlCNS: "10000000", market },
          ] };
      return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
    };
    const d = await getLeaderData(LEADER, { now: NOW, fetch: envioFetch });
    expect(d.source).toBe("envio");
    expect(d.fills.map((x) => [x.price, x.size, x.positionAfter])).toEqual([[100000, 1, 1], [110000, 1, 0]]);
    expect(d.closedTrades[0].netPnl).toBeCloseTo(10 - 0.0345 - 0.03795, 9);
  });

  it("falls back to plumb while the indexer is still backfilling", async () => {
    process.env.ENVIO_GRAPHQL_URL = "http://envio.test/v1/graphql";
    const stale: typeof fetch = async (u, init) =>
      String(u).startsWith("http://envio.test")
        ? new Response(JSON.stringify({ data: { Protocol: [{ lastUpdatedAt: NOW - 30 * 86400 }] } }), { headers: { "content-type": "application/json" } })
        : stubFetch(u, init);
    expect((await getLeaderData(LEADER, { now: NOW, fetch: stale })).source).toBe("plumb");
  });
});

describe("QA fixes", () => {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

  it("testnet LeaderBooks: chain-filtered Envio fills with the static testnet market table", async () => {
    process.env.ENVIO_GRAPHQL_URL = "http://envio.test/v1/graphql";
    const sent: any[] = [];
    // raw indexer rows for testnet BTC (perp 16): the indexer's Market row says PERP-16 with 0 decimals
    const market = { perpId: 16, symbol: "PERP-16", priceDecimals: 0, lotDecimals: 0 };
    const f: typeof fetch = async (u, init) => {
      if (!String(u).startsWith("http://envio.test")) return stubFetch(u, init);
      const b = JSON.parse(String(init?.body));
      sent.push(b);
      if (b.query.includes("Account(")) return json({ data: { Account: [{ id: "1101", chainId: 10143, fills: 2, closedTrades: 1, wins: 0, netPnlCNS: "-50167", maxDrawdownCNS: "50167", firstSeenAt: NOW - 100, lastSeenAt: NOW - 50 }] } });
      return json({ data: { Fill: [
        { id: "1-5", timestamp: NOW - 100, block: 1, txHash: "0xa", role: "TAKER", side: "BUY", pricePNS: "836807", lotLNS: "40", feeCNS: "11548", realizedPnlCNS: "0", market },
        { id: "2-35", timestamp: NOW - 50, block: 2, txHash: "0xb", role: "TAKER", side: "SELL", pricePNS: "836146", lotLNS: "40", feeCNS: "11539", realizedPnlCNS: "-27080", market },
      ] } });
    };
    const d = await getLeaderData("0xb1b08f6a0642c51b48c1916136458a769a1c5208", { now: NOW, fetch: f });
    expect(d).toMatchObject({ chainId: 10143, source: "envio", official30d: null });
    expect(sent.find((b) => b.query.includes("Fill("))?.variables).toMatchObject({ acc: "1101", chain: 10143 });
    expect(d.fills.map((x) => [x.symbol, x.price, x.size])).toEqual([["BTC", 83680.7, 0.0004], ["BTC", 83614.6, 0.0004]]);
    expect(d.fills[0].notional).toBeCloseTo(33.47228, 6);
    expect(d.stats.medianNotional).toBeLessThan(100);
    expect(d.stats.closedTrades).toBe(1);
    expect(d.stats.markets[0].symbol).toBe("BTC");
  });

  it("Nansen out of credits: alignment is 200 + degraded, discovery still ranks", async () => {
    process.env.NANSEN_API_KEY = "k";
    const broke: typeof fetch = async (u, init) =>
      String(u).includes("api.nansen.ai") ? json({ error: "Insufficient credits" }, 403) : stubFetch(u, init);
    const app = createApp({ fetch: broke, now: () => NOW });
    const r = await app.request(`/leader/${LEADER}/alignment`);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ unavailable: "nansen-credits", alignment: { score: null, poweredBy: null } });
    expect(j.error).toMatch(/403/);
    expect(j.composite.poweredBy).toBeNull();
    const dsc = await app.request("/discover?limit=3");
    expect(dsc.status).toBe(200);
    const dj = await dsc.json();
    expect(dj).toMatchObject({ unavailable: "nansen-credits", poweredBy: null, nansen: { available: false } });
    expect(dj.candidates.length).toBe(3);
    expect(dj.candidates.every((c: any) => c.composite.poweredBy === null)).toBe(true);
  });

  it("caches the Monad netflow for an hour", async () => {
    process.env.NANSEN_API_KEY = "k";
    let hits = 0;
    const f: typeof fetch = async (u, init) => {
      if (String(u).includes("smart-money/netflow")) hits++;
      return stubFetch(u, init);
    };
    const c = nansenClient({ fetch: f });
    const t = 1_000_000;
    await fetchMonadNetflow(c, t);
    await fetchMonadNetflow(c, t + 59 * 60_000);
    expect(hits).toBe(1);
    await fetchMonadNetflow(c, t + 61 * 60_000);
    expect(hits).toBe(2);
  });

  it("drops POST /kimi/verify", async () => {
    const app = createApp({ fetch: stubFetch, now: () => NOW });
    expect((await app.request("/kimi/verify", { method: "POST", body: "{}" })).status).toBe(404);
  });

  it("strips code identifiers, severities and unix timestamps from LLM text", () => {
    const out = humanize("Tilt: sizeUpsAfterLoss = 2 (severity 0.9) since 1790740438, see `max_drawdown`.");
    expect(out).not.toMatch(/sizeUpsAfterLoss|severity|1790740438|`|_/);
    expect(out).toContain("size ups after loss 2");
    expect(out).toContain("2026-");
    const g = guardAnalysis({ styleSummary: { en: "weeklySummary: fine" } }, { tilt: { detected: false }, drift: { detected: false }, reasonsNotToFollow: [] } as any);
    expect(g.styleSummary).toEqual({ en: "weekly summary fine", id: "weekly summary fine" });
  });
});
