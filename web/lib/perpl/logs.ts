import "server-only";
import { createPublicClient, decodeEventLog, http, toEventSelector, type Hex, type Log } from "viem";
import { monad } from "../chains";
import { perplExchangeAbi } from "./abi";
import { EXCHANGE, rpc } from "./onchain";

/**
 * Event history without an indexer.
 * Public RPC getLogs caps (re-verified 11 Oct 2026): rpc.monad.xyz / rpc1 / rpc3 = 100 blocks,
 * rpc2.monad.xyz = 10k blocks (rpc1's old ~1M allowance is gone). We scan 10k-block chunks
 * with bounded concurrency, back off on 429, and split a range in half if the node refuses it.
 * When NEXT_PUBLIC_ENVIO_GRAPHQL_URL is set, lib/perpl/indexer.ts is preferred.
 */
const logsRpc = createPublicClient({
  chain: monad,
  transport: http(process.env.MONAD_LOGS_RPC_URL || "https://rpc2.monad.xyz", { timeout: 45_000, retryCount: 0 }),
});

/** Monad mainnet: ~0.4s blocks -> ~216k blocks/day. Used only to size scan windows. */
export const BLOCKS_PER_DAY = 216_000n;

export const ev = (name: string) => {
  const item = perplExchangeAbi.find((x) => x.type === "event" && x.name === name);
  if (!item) throw new Error(`event ${name} not in abi`);
  return toEventSelector(item as never);
};

type RawLog = Log<bigint, number, false>;

async function getLogsRange(topics: Hex[], from: bigint, to: bigint, depth = 0, tries = 0): Promise<RawLog[]> {
  try {
    return (await logsRpc.request({
      method: "eth_getLogs",
      params: [{ address: EXCHANGE, topics: [topics], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
    })) as unknown as RawLog[];
  } catch (e) {
    // Only "too big" errors are worth splitting; anything else (rate limit, outage) is retried up to 3 times, then surfaced.
    const msg = String((e as Error)?.message);
    const tooBig = /size|range|exceed/i.test(msg) && !/rate limit/i.test(msg);
    if (!tooBig) {
      // rate limit / transient: back off and retry the same range
      if (tries >= 3) throw e;
      await new Promise((r) => setTimeout(r, 600 * (tries + 1)));
      return getLogsRange(topics, from, to, depth, tries + 1);
    }
    if (depth > 8 || to - from < 50n) throw e;
    const mid = from + (to - from) / 2n;
    const [a, b] = await Promise.all([getLogsRange(topics, from, mid, depth + 1), getLogsRange(topics, mid + 1n, to, depth + 1)]);
    return a.concat(b);
  }
}

/** Scan [head - blocks, head] in chunks, at most `conc` requests in flight. */
export async function scan(topics: Hex[], blocks: bigint, chunk = 10_000n, conc = 8) {
  const head = await rpc.getBlockNumber();
  const start = head - blocks;
  const ranges: [bigint, bigint][] = [];
  for (let f = start; f <= head; f += chunk) ranges.push([f, f + chunk - 1n > head ? head : f + chunk - 1n]);
  const parts: RawLog[][] = new Array(ranges.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(conc, ranges.length) }, async () => {
      while (next < ranges.length) {
        const k = next++;
        parts[k] = await getLogsRange(topics, ...ranges[k]);
      }
    }),
  );
  return { head, start, logs: parts.flat() };
}

export function decode(log: RawLog) {
  return decodeEventLog({ abi: perplExchangeAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
}

/** Linear block->time interpolation from a handful of anchor blocks (Monad block time drifts slowly). */
export async function timeline(from: bigint, to: bigint, anchors = 8) {
  const pts: bigint[] = [];
  for (let i = 0; i <= anchors; i++) pts.push(from + ((to - from) * BigInt(i)) / BigInt(anchors));
  const blocks = await Promise.all(pts.map((b) => rpc.getBlock({ blockNumber: b })));
  const xs = blocks.map((b) => Number(b.number));
  const ts = blocks.map((b) => Number(b.timestamp) * 1000);
  return (block: number) => {
    let i = 0;
    while (i < xs.length - 2 && block > xs[i + 1]) i++;
    const k = (block - xs[i]) / (xs[i + 1] - xs[i] || 1);
    return Math.round(ts[i] + k * (ts[i + 1] - ts[i]));
  };
}

/** Second data word of most position events is the account id: cheap pre-filter before decoding. */
export const accountWord = (id: number) => id.toString(16).padStart(64, "0");
export const dataWord = (data: Hex, i: number) => data.slice(2 + 64 * i, 2 + 64 * (i + 1));
