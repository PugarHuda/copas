import "server-only";
import { createPublicClient, http, type Abi } from "viem";
import { copasChain } from "../chains";
import { copasAbi, deployment, isDeployed, perpIdsForChain } from "./contracts";
import { MOCK_LEADERS, findMockLeader, type Leader } from "../mock/copas";

const client = createPublicClient({ chain: copasChain, transport: http() });
const STATUS = ["active", "unbonded", "breached", "closed"] as const;
const A = (v: unknown) => Number(v as bigint) / 1e6;

/** Leaders from CopasRegistry when deployed, otherwise the mock set. Second value says which. */
export async function getLeaders(): Promise<{ leaders: Leader[]; source: "chain" | "mock" }> {
  if (!isDeployed) return { leaders: MOCK_LEADERS, source: "mock" }; // MOCK until contracts deployed
  try {
    const reg = { address: deployment!.registry!, abi: copasAbi.CopasRegistry as Abi };
    const n = Number(await client.readContract({ ...reg, functionName: "leaderCount" }));
    const books = (await client.multicall({
      contracts: Array.from({ length: n }, (_, i) => ({ ...reg, functionName: "leaderBooks", args: [BigInt(i)] })),
      allowFailure: false,
    })) as `0x${string}`[];
    return { leaders: await Promise.all(books.map(readLeader)), source: "chain" };
  } catch {
    return { leaders: MOCK_LEADERS, source: "mock" };
  }
}

export async function getLeader(book: string): Promise<{ leader: Leader | null; source: "chain" | "mock" }> {
  if (!isDeployed) return { leader: findMockLeader(book) ?? null, source: "mock" };
  try {
    return { leader: await readLeader(book as `0x${string}`), source: "chain" };
  } catch {
    return { leader: null, source: "chain" };
  }
}

async function readLeader(book: `0x${string}`): Promise<Leader> {
  const lb = { address: book, abi: copasAbi.LeaderBook as Abi };
  const fns = ["owner", "status", "bond", "mandate", "unitPrice", "peakUnitPrice", "epoch", "epochEnd", "capacity", "capTotalNext", "pool", "operator"] as const;
  const r = (await client.multicall({ contracts: fns.map((f) => ({ ...lb, functionName: f })), allowFailure: false })) as unknown[];
  const [owner, status, bond, mandate, unit, peak, epoch, epochEnd, capacity, capTotal, pool, operator] = r;
  const m = mandate as { maxDDbps: number; maxLeverageHdths: number; feeBps: number; epochLen: bigint; maxNotionalCNS: bigint; marketsMask: bigint };
  const u = Number((unit as [bigint, boolean])[0]) / 1e18;
  const pk = Number(peak as bigint) / 1e18;
  const uw = pool && pool !== "0x0000000000000000000000000000000000000000"
    ? A(await client.readContract({ address: pool as `0x${string}`, abi: copasAbi.UnderwriterPool as Abi, functionName: "assets" }))
    : 0;
  const names = Object.keys(perpIdsForChain());
  return {
    book,
    owner: owner as `0x${string}`,
    name: `${book.slice(0, 6)}…${book.slice(-4)}`, // TODO: leader display names (ENS / profile)
    agent: operator !== owner ? { erc8004Id: 0, model: "operator " + String(operator).slice(0, 8) } : undefined,
    status: STATUS[Number(status)] ?? "closed",
    bond: A(bond),
    underwritten: uw,
    maxDD: m.maxDDbps / 100,
    liveDD: pk > 0 ? Math.max(0, (1 - u / pk) * 100) : 0,
    unitPrice: u,
    peakUnitPrice: pk,
    epoch: Number(epoch),
    epochEnd: Number(epochEnd) * 1000,
    epochLenH: Number(m.epochLen) / 3600,
    followerAum: A(capTotal),
    followers: 0, // TODO: count FollowerRegistered events via Envio
    capacity: A(capacity),
    maxLeverage: m.maxLeverageHdths / 100,
    maxNotional: A(m.maxNotionalCNS),
    markets: names.filter((_, i) => (m.marketsMask >> BigInt(i)) & 1n),
    feePct: m.feeBps / 100,
    tier: "custom",
    return30d: (u - 1) * 100,
    perplAccount: book, // the LeaderBook owns its Perpl account
  };
}

const ZERO = "0x0000000000000000000000000000000000000000";
const bookAbi = [{ type: "function", name: "bestBidAsk", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }, { type: "uint256" }] }] as const;

/** Live UP/DOWN series for this or next epoch, plus Kuru top of book when DOWN is listed. Null = nothing minted yet. */
export async function getDownMarket(book: string, epoch: number) {
  if (!deployment?.breachMarket) return null;
  const bm = { address: deployment.breachMarket, abi: copasAbi.BreachMarket as Abi };
  for (const e of [epoch, epoch + 1]) {
    const s = (await client.readContract({ ...bm, functionName: "series", args: [book, BigInt(e)] }).catch(() => null)) as
      | { up: `0x${string}`; down: `0x${string}`; settled: boolean; breach: boolean }
      | null;
    if (!s || s.down === ZERO) continue;
    const supply = A(await client.readContract({ address: s.down, abi: copasAbi.BreachToken as Abi, functionName: "totalSupply" }));
    const market = deployment.kuruDownMarkets?.[s.down.toLowerCase()];
    let bid = 0, ask = 0;
    if (market) {
      const [b, a] = (await client.readContract({ address: market, abi: bookAbi, functionName: "bestBidAsk" })) as [bigint, bigint];
      bid = Number(b) / 1e18;
      ask = a >= 2n ** 255n ? 0 : Number(a) / 1e18; // empty ask side reads as max uint
    }
    return { epoch: e, down: s.down, up: s.up, market, supply, bid, ask, settled: s.settled, breach: s.breach };
  }
  return null;
}
