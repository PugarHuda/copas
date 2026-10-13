/**
 * Oracle cross-check of Perpl marks, read onchain in one multicall (optionally at a past block: Monad RPC serves
 * archive state). Perpl's own reference is Chainlink Data Streams (PerpetualInfo.linkFeedId / oraclePNS); this
 * compares the mark against oracles Perpl does not use, so a follower can tell a market-wide move from a
 * Perpl-only dislocation (thin book, manipulated mark) when a leader checkpoints or breaches.
 *
 * Sources (addresses from docs.monad.xyz/tooling-and-infra/oracles and github.com/monad-crypto/protocols):
 *  - Pyth PriceFeed 0x2880…7B43 getPriceUnsafe. Mainnet: sponsored push feeds (1h heartbeat, 0.02% deviation).
 *    Testnet: nobody pushes, so it is usually stale and reported as such. Hermes HTTP now answers 401 without a key.
 *  - Chainlink Data Feeds (push) latestRoundData. Same provider family as Perpl's Data Streams, so `independent: false`.
 *  - Supra DORA push storage getSvalue (testnet only: the mainnet storage has no BTC/ETH pair).
 */
import { createPublicClient, http, parseAbi } from "viem";
import { MAINNET, MARKETS, MULTICALL3, PERPL_ABI, PERPL_EXCHANGE, TESTNET, TESTNET_MARKETS, envio } from "./leaderData.js";
import { type Fetch, median, round, rpcUrl } from "./util.js";

const ABI = parseAbi([
  "struct PythPrice { int64 price; uint64 conf; int32 expo; uint256 publishTime; }",
  "function getPriceUnsafe(bytes32 id) view returns (PythPrice)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "struct SupraFeed { uint256 round; uint256 decimals; uint256 time; uint256 price; }",
  "function getSvalue(uint256 pairIndex) view returns (SupraFeed)",
  "function getCurrentBlockTimestamp() view returns (uint256)",
  "function getBlockNumber() view returns (uint256)",
]);

export { ABI as ORACLE_ABI };
export const PYTH: `0x${string}` = "0x2880aB155794e7179c9eE2e38200202908C17B43";
const SUPRA_TESTNET: `0x${string}` = "0xf0e852BC3F940447862D6b67e5B9807E64B433F6";
const PYTH_ID = {
  BTC: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  ETH: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  SOL: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  MON: "0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1",
  HYPE: "0x4279e31cc369bbcc2faf022b382b080e32a8e689ff20fbc530d2a603eb6cd98b",
} as const;

type Src =
  | { provider: "pyth"; feed: string }
  | { provider: "chainlink"; address: `0x${string}`; decimals: number; feed: string }
  | { provider: "supra"; pair: number; feed: string };
const pyth = (s: keyof typeof PYTH_ID): Src => ({ provider: "pyth", feed: PYTH_ID[s] });
const cl = (address: `0x${string}`, decimals: number, feed: string): Src => ({ provider: "chainlink", address, decimals, feed });

/** Per chain, per Perpl symbol. Chainlink decimals were read onchain (decimals()) on 2026-10-13. */
const SOURCES: Record<number, Record<string, Src[]>> = {
  [MAINNET]: {
    BTC: [pyth("BTC"), cl("0xc1d4C3331635184fA4C3c22fb92211B2Ac9E0546", 8, "BTC / USD")],
    ETH: [pyth("ETH"), cl("0x38057D0458ca56068e1A57E62D3874cA129A7A78", 18, "ETH / USD")],
    MON: [pyth("MON"), cl("0xFB504aD06Ab5E6c63FE0A46FEa245214838E8015", 18, "MON / USD")],
    SOL: [pyth("SOL")],
    HYPE: [pyth("HYPE")],
  },
  [TESTNET]: {
    BTC: [pyth("BTC"), cl("0x12C0F44368a02081ce58a936d1C1F606BB301715", 8, "BTC / USD"), { provider: "supra", pair: 18, feed: "BTC_USD" }],
    ETH: [pyth("ETH"), cl("0x5c8c8482f064049248F86D9F4aFa4B1f2F5b6d31", 8, "ETH / USD"), { provider: "supra", pair: 19, feed: "ETH_USD" }],
    SOL: [pyth("SOL"), { provider: "supra", pair: 10, feed: "SOL_USDT" }],
    MON: [pyth("MON")],
  },
};

/** ponytail: fixed thresholds, calibrate per market if majors vs alts need different bands. */
export const ORACLE_MAX_AGE_SEC = 3600; // push feeds heartbeat 1h: older is stale
export const WATCH_BPS = 30;
export const SPIKE_BPS = 100;

export type OracleStatus = "ok" | "watch" | "spike" | "no_fresh_oracle";
export interface OracleSource {
  provider: "pyth" | "chainlink" | "supra";
  feed: string;
  address: string;
  independent: boolean; // false for Chainlink: Perpl's own reference is Chainlink Data Streams
  price: number;
  confidence: number | null; // Pyth only, same units as price
  publishTime: number;
  ageSec: number;
  fresh: boolean;
  deviationBps: number; // (Perpl mark - oracle) / oracle
}
export interface OracleMarket {
  perpId: number;
  symbol: string;
  mark: number;
  markTime: number;
  perplOracle: { provider: "Chainlink Data Streams (Perpl reference)"; price: number; time: number; deviationBps: number };
  sources: OracleSource[];
  reference: number | null; // median of fresh sources
  deviationBps: number | null; // mark vs reference
  status: OracleStatus;
}
export interface OracleCheck {
  chainId: number;
  block: number;
  blockTime: number;
  markets: OracleMarket[];
  maxAbsDeviationBps: number | null;
  status: OracleStatus;
  summary: string;
  thresholds: { watchBps: number; spikeBps: number; maxAgeSec: number };
}

const scale = (x: bigint, e: number) => (e < 0 ? Number(x) / 10 ** -e : Number(x) * 10 ** e);
const bps = (a: number, b: number) => round(((a - b) / b) * 1e4, 2);
const RANK: OracleStatus[] = ["no_fresh_oracle", "ok", "watch", "spike"];
export const statusOf = (dev: number | null): OracleStatus => (dev == null ? "no_fresh_oracle" : Math.abs(dev) >= SPIKE_BPS ? "spike" : Math.abs(dev) >= WATCH_BPS ? "watch" : "ok");

export async function oracleCheck(chainId: number, opts: { block?: number; fetch?: Fetch } = {}): Promise<OracleCheck> {
  if (chainId !== MAINNET && chainId !== TESTNET) throw new Error(`chain must be ${MAINNET} or ${TESTNET}`);
  const client = createPublicClient({ transport: http(rpcUrl(chainId), { fetchFn: opts.fetch, retryCount: 1, timeout: 10_000 }) });
  const perps = chainId === TESTNET ? Object.entries(TESTNET_MARKETS).map(([id, m]) => [Number(id), m.symbol] as const) : Object.entries(MARKETS).map(([id, s]) => [Number(id), s] as const);
  const srcs = perps.map(([, s]) => SOURCES[chainId][s] ?? []);
  const ex = { address: PERPL_EXCHANGE[chainId], abi: PERPL_ABI } as const;
  const call = (s: Src) =>
    s.provider === "pyth"
      ? { address: PYTH, abi: ABI, functionName: "getPriceUnsafe", args: [s.feed] }
      : s.provider === "chainlink"
        ? { address: s.address, abi: ABI, functionName: "latestRoundData" }
        : { address: SUPRA_TESTNET, abi: ABI, functionName: "getSvalue", args: [BigInt(s.pair)] };
  const contracts = [
    { address: MULTICALL3, abi: ABI, functionName: "getCurrentBlockTimestamp" },
    { address: MULTICALL3, abi: ABI, functionName: "getBlockNumber" },
    ...perps.map(([id]) => ({ ...ex, functionName: "getPerpetualInfo", args: [BigInt(id)] })),
    ...srcs.flat().map(call),
  ];
  const res = (await client.multicall({ multicallAddress: MULTICALL3, contracts: contracts as any, allowFailure: true, blockNumber: opts.block == null ? undefined : BigInt(opts.block) })) as { status: string; result?: any }[];
  if (res[0].status !== "success") throw new Error("multicall failed");
  const now = Number(res[0].result);
  const block = Number(res[1].result);
  let k = 2 + perps.length;
  const markets: OracleMarket[] = [];
  perps.forEach(([perpId, symbol], i) => {
    const info = res[2 + i];
    const own = srcs[i].map((s) => ({ s, r: res[k++] }));
    if (info.status !== "success") return; // market not listed at this block
    const p = info.result;
    const d = 10 ** Number(p.priceDecimals);
    const mark = Number(p.markPNS) / d;
    if (!mark) return;
    const sources: OracleSource[] = [];
    for (const { s, r } of own) {
      if (r.status !== "success") continue; // e.g. Pyth PriceFeedNotFound
      const v = r.result;
      const [price, conf, time, address] =
        s.provider === "pyth"
          ? [scale(v.price, v.expo), scale(v.conf, v.expo), Number(v.publishTime), PYTH]
          : s.provider === "chainlink"
            ? [Number(v[1]) / 10 ** s.decimals, null, Number(v[3]), s.address]
            : [Number(v.price) / 10 ** Number(v.decimals), null, Math.floor(Number(v.time) / 1000), SUPRA_TESTNET];
      if (!(price > 0)) continue;
      const ageSec = now - time;
      sources.push({ provider: s.provider, feed: s.feed, address, independent: s.provider !== "chainlink", price, confidence: conf, publishTime: time, ageSec, fresh: ageSec <= ORACLE_MAX_AGE_SEC, deviationBps: bps(mark, price) });
    }
    const fresh = sources.filter((s) => s.fresh).map((s) => s.price);
    const reference = fresh.length ? median(fresh) : null;
    const deviationBps = reference ? bps(mark, reference) : null;
    const oracle = Number(p.oraclePNS) / d;
    markets.push({
      perpId,
      symbol,
      mark,
      markTime: Number(p.markTimestamp),
      perplOracle: { provider: "Chainlink Data Streams (Perpl reference)", price: oracle, time: Number(p.oracleTimestampSec), deviationBps: oracle ? bps(mark, oracle) : 0 },
      sources,
      reference,
      deviationBps,
      status: statusOf(deviationBps),
    });
  });
  const devs = markets.flatMap((m) => (m.deviationBps == null ? [] : [Math.abs(m.deviationBps)]));
  const maxAbsDeviationBps = devs.length ? Math.max(...devs) : null;
  const status = markets.reduce<OracleStatus>((w, m) => (RANK.indexOf(m.status) > RANK.indexOf(w) ? m.status : w), "no_fresh_oracle");
  return { chainId, block, blockTime: now, markets, maxAbsDeviationBps, status, summary: summarize(markets, block), thresholds: { watchBps: WATCH_BPS, spikeBps: SPIKE_BPS, maxAgeSec: ORACLE_MAX_AGE_SEC } };
}

export function summarize(markets: OracleMarket[], block: number): string {
  const checked = markets.filter((m) => m.deviationBps != null);
  if (!checked.length) return `No fresh oracle price at block ${block}: Perpl marks could not be cross-checked.`;
  const worst = checked.reduce((a, b) => (Math.abs(b.deviationBps!) > Math.abs(a.deviationBps!) ? b : a));
  const unchecked = markets.filter((m) => m.deviationBps == null).map((m) => m.symbol);
  const tail = unchecked.length ? ` No fresh oracle for ${unchecked.join(", ")}.` : "";
  if (worst.status === "spike")
    return `Oracle deviation spike at block ${block}: Perpl ${worst.symbol} mark was ${worst.deviationBps} bps from independent oracles. A checkpoint or breach here may come from a Perpl-only price dislocation, not a market-wide move.${tail}`;
  return `Perpl marks were within ${Math.abs(worst.deviationBps!)} bps of oracles at block ${block} (worst: ${worst.symbol}). Price moves here were market-wide, not a Perpl-only dislocation.${tail}`;
}

/**
 * A LeaderBook's breaches (and its latest checkpoint) with the oracle check at each block, so a follower sees whether
 * a breach happened during a deviation spike. One Envio query, then one multicall per block (<= 6).
 */
export async function leaderOracleContext(envioUrl: string, leaderBook: string, f?: Fetch) {
  const d = await envio<{ Checkpoint: { epoch: number; block: number; timestamp: number; ddBps: number }[]; Breach: { epoch: number; reason: number; timestamp: number; txHash: string }[] }>(
    envioUrl,
    `query($l: String!) {
      Checkpoint(where: { chainId: { _eq: ${TESTNET} }, leader_id: { _eq: $l } }, order_by: { timestamp: desc }, limit: 100) { epoch block timestamp ddBps }
      Breach(where: { chainId: { _eq: ${TESTNET} }, leader_id: { _eq: $l } }, order_by: { timestamp: desc }, limit: 5) { epoch reason timestamp txHash } }`,
    { l: leaderBook.toLowerCase() },
    f ?? fetch,
  );
  const REASON = ["", "drawdown", "leverage", "notional", "market"];
  // the checkpoint that tripped a breach is in the same epoch, at or before the Breached event
  const events = d.Breach.map((b) => ({ kind: "breach" as const, epoch: b.epoch, reason: REASON[b.reason] ?? String(b.reason), txHash: b.txHash, cp: d.Checkpoint.find((c) => c.epoch === b.epoch && c.timestamp <= b.timestamp) }))
    .filter((e) => e.cp)
    .map(({ cp, ...e }) => ({ ...e, block: cp!.block, timestamp: cp!.timestamp, ddPct: cp!.ddBps / 100 }));
  const last = d.Checkpoint[0];
  const rows = [...(last && !events.some((e) => e.block === last.block) ? [{ kind: "latest_checkpoint" as const, epoch: last.epoch, block: last.block, timestamp: last.timestamp, ddPct: last.ddBps / 100 }] : []), ...events];
  const checks = await Promise.all(rows.map((r) => oracleCheck(TESTNET, { block: r.block, fetch: f })));
  return { leaderBook: leaderBook.toLowerCase(), chainId: TESTNET, events: rows.map((r, i) => ({ ...r, oracle: checks[i] })) };
}
