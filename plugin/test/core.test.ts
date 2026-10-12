import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, erc20Abi, toFunctionSelector } from "viem";
import {
  abi,
  agentNameFromUri,
  buildFollowParams,
  buildTightenParams,
  checkWithdrawCap,
  DAY_MS,
  encode,
  type FollowFlags,
  InputError,
  parseAusd,
  parseChainId,
  parseLeverage,
  parseMarkets,
  parsePerpId,
  parseRatio,
  protectionRatioBps,
  type RegistryMarket,
} from "../src/lib/core.ts";

const mainnetMarkets: RegistryMarket[] = [
  { perpId: 1, priceDecimals: 1, lotDecimals: 5 },
  { perpId: 10, priceDecimals: 6, lotDecimals: 1 },
  { perpId: 20, priceDecimals: 2, lotDecimals: 4 },
  { perpId: 31, priceDecimals: 3, lotDecimals: 3 },
];
const testnetMarkets: RegistryMarket[] = [16, 32, 48, 64].map((perpId) => ({ perpId, priceDecimals: 2, lotDecimals: 4 }));

const VAULT = "0x1111111111111111111111111111111111111111";
const LEADER = "0x2222222222222222222222222222222222222222";
const AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";

const fullFlags: FollowFlags = { ratio: "0.5", maxNotional: "50", maxLeverage: "3x", chaseBps: "50", bandBps: "30", stopLossBps: "1500", markets: "btc, ETH" };

const code = (c: string) => (e: unknown) => e instanceof InputError && e.code === c;

test("parse amounts, ratios, leverage, chains", () => {
  assert.equal(parseAusd("12.5"), 12_500_000n);
  assert.equal(parseAusd("100 AUSD"), 100_000_000n);
  assert.throws(() => parseAusd("0"), code("COPAS_INVALID_AMOUNT"));
  assert.throws(() => parseAusd("1.0000001"), code("COPAS_INVALID_AMOUNT"));
  assert.throws(() => parseAusd("-5"), code("COPAS_INVALID_AMOUNT"));
  assert.equal(parseRatio("0.25"), 2_500);
  assert.equal(parseRatio("5x"), 50_000);
  assert.throws(() => parseRatio("5.1"), code("COPAS_INVALID_RATIO"));
  assert.equal(parseLeverage("2.5x"), 250);
  assert.throws(() => parseLeverage("0.5"), code("COPAS_INVALID_LEVERAGE"));
  assert.equal(parseChainId(undefined), 143);
  assert.equal(parseChainId("testnet"), 10143);
  assert.throws(() => parseChainId("1"), code("COPAS_UNSUPPORTED_CHAIN"));
});

test("market symbols map to Perpl perp ids and registry bitmask per chain", () => {
  assert.equal(parseMarkets("BTC,ETH", 143, mainnetMarkets).mask, 0b101n);
  assert.equal(parseMarkets("MON", 10143, testnetMarkets).mask, 0b1000n);
  assert.equal(parsePerpId("sol", 143), 31);
  assert.equal(parsePerpId("SOL", 10143), 48);
  assert.throws(() => parseMarkets("DOGE", 143, mainnetMarkets), code("COPAS_INVALID_MARKETS"));
  assert.throws(() => parseMarkets("SOL", 143, mainnetMarkets.slice(0, 2)), code("COPAS_MARKET_NOT_LISTED"));
});

test("follow refuses without every risk limit", () => {
  for (const k of Object.keys(fullFlags) as (keyof FollowFlags)[]) {
    assert.throws(() => buildFollowParams({ ...fullFlags, [k]: undefined }, 143, mainnetMarkets), code("COPAS_LIMITS_REQUIRED"), k);
  }
  assert.throws(() => buildFollowParams({}, 143, mainnetMarkets), /--ratio, --max-notional, --max-leverage, --chase-bps, --band-bps, --stop-loss-bps, --markets/);
  assert.throws(() => buildFollowParams({ ...fullFlags, bandBps: "0" }, 143, mainnetMarkets), code("COPAS_INVALID_BPS"));
  assert.deepEqual(buildFollowParams(fullFlags, 143, mainnetMarkets), {
    ratioBps: 5_000,
    maxNotionalCNS: 50_000_000n,
    maxLeverageHdths: 300,
    maxChaseBps: 50,
    priceBandBps: 30,
    stopLossBps: 1_500,
    marketsMask: 0b101n,
  });
});

test("tighten only lowers risk", () => {
  const cur = buildFollowParams(fullFlags, 143, mainnetMarkets);
  const next = buildTightenParams(cur, { maxLeverage: "2", markets: "BTC", stopLossBps: "1000" }, 143, mainnetMarkets);
  assert.equal(next.maxLeverageHdths, 200);
  assert.equal(next.marketsMask, 1n);
  assert.equal(next.ratioBps, cur.ratioBps);
  assert.throws(() => buildTightenParams(cur, { ratio: "1" }, 143, mainnetMarkets), code("COPAS_NOT_TIGHTER"));
  assert.throws(() => buildTightenParams(cur, { markets: "BTC,MON" }, 143, mainnetMarkets), code("COPAS_NOT_TIGHTER"));
  assert.throws(() => buildTightenParams(cur, { stopLossBps: "2000" }, 143, mainnetMarkets), code("COPAS_NOT_TIGHTER"));
});

test("calldata round-trips through the contract ABIs", () => {
  const p = buildFollowParams(fullFlags, 143, mainnetMarkets);
  const f = encode.follow(VAULT, LEADER, p);
  assert.equal(f.to, VAULT);
  const df = decodeFunctionData({ abi: abi("FollowerVault"), data: f.data });
  assert.equal(df.functionName, "follow");
  assert.equal((df.args as unknown[])[0], LEADER);
  assert.deepEqual((df.args as unknown[])[1], p);
  assert.equal(f.data.slice(0, 10), toFunctionSelector("follow(address,(uint32,uint32,uint32,uint32,uint32,uint128,uint256))"));

  const t = decodeFunctionData({ abi: abi("FollowerVault"), data: encode.tighten(VAULT, p).data });
  assert.equal(t.functionName, "tighten");

  const cases: [ReturnType<typeof encode.deposit>, string, unknown[] | undefined][] = [
    [encode.deposit(VAULT, 25_000_000n), "deposit", [25_000_000n]],
    [encode.withdraw(VAULT, 1n), "withdraw", [1n]],
    [encode.sync(VAULT, 20), "sync", [20n]],
    [encode.claim(VAULT, LEADER, 3n), "claim", [LEADER, 3n]],
    [encode.unfollow(VAULT), "unfollow", undefined],
    [encode.setReferrer(VAULT, LEADER), "setReferrer", [LEADER]],
  ];
  for (const [tx, fn, args] of cases) {
    const d = decodeFunctionData({ abi: abi("FollowerVault"), data: tx.data });
    assert.equal(d.functionName, fn);
    assert.deepEqual(d.args, args);
  }

  assert.equal(decodeFunctionData({ abi: abi("LeaderBook"), data: encode.checkpoint(LEADER).data }).functionName, "checkpoint");
  const uw: [ReturnType<typeof encode.uwDeposit>, string, unknown[] | undefined][] = [
    [encode.uwDeposit(VAULT, 5n), "deposit", [5n]],
    [encode.uwRequestWithdraw(VAULT, 9n), "requestWithdraw", [9n]],
    [encode.uwWithdraw(VAULT), "withdraw", undefined],
  ];
  for (const [tx, fn, args] of uw) {
    const d = decodeFunctionData({ abi: abi("UnderwriterPool"), data: tx.data });
    assert.equal(d.functionName, fn);
    assert.deepEqual(d.args, args);
  }

  const cv = encode.createVault(VAULT);
  assert.equal(decodeFunctionData({ abi: abi("CopasRegistry"), data: cv.data }).functionName, "createVault");

  const ap = encode.approve(AUSD, VAULT, 7n);
  assert.equal(ap.to, AUSD);
  assert.deepEqual(decodeFunctionData({ abi: erc20Abi, data: ap.data }).args, [VAULT, 7n]);
});

test("withdraw outflow cap is a rolling 24h window", () => {
  const now = 10 * DAY_MS;
  const ledger = [
    { ts: now - DAY_MS - 1, amount: "90000000", chainId: 143, vault: VAULT }, // expired
    { ts: now - 1000, amount: "30000000", chainId: 143, vault: VAULT },
  ];
  assert.equal(checkWithdrawCap(ledger, 20_000_000n, 50_000_000n, now), 30_000_000n);
  assert.throws(() => checkWithdrawCap(ledger, 20_000_001n, 50_000_000n, now), code("COPAS_OUTFLOW_CAP"));
});

test("protection ratio = bond / AUM, capped at 100%", () => {
  assert.equal(protectionRatioBps(25_000_000n, 250_000_000n), 1_000);
  assert.equal(protectionRatioBps(500n, 100n), 10_000);
  assert.equal(protectionRatioBps(1n, 0n), 10_000);
});

test("ERC-8004 agent name: inline data: JSON only, capped at 40 chars", () => {
  const b64 = Buffer.from(JSON.stringify({ name: "Copas Momentum Agent" })).toString("base64");
  assert.equal(agentNameFromUri(`data:application/json;base64,${b64}`), "Copas Momentum Agent");
  assert.equal(agentNameFromUri(`data:application/json,${encodeURIComponent('{"name":"  x  "}')}`), "x");
  assert.equal(agentNameFromUri(`data:application/json,{"name":"${"a".repeat(60)}"}`)?.length, 40);
  assert.equal(agentNameFromUri("https://evil.example/agent.json"), undefined);
  assert.equal(agentNameFromUri("data:application/json;base64,!!!"), undefined);
});
