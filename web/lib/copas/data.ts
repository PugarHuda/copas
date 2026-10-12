import "server-only";
import { unstable_cache } from "next/cache";
import { createPublicClient, erc721Abi, http, namehash, parseAbi, parseAbiItem, type Abi } from "viem";
import { normalize } from "viem/ens";
import { PERPL, copasChain, monad, rpcTransport } from "../chains";
import { perplExchangeAbi } from "../perpl/abi";
import { toPosition, type Position, type RawPos } from "../perpl/onchain";
import { short } from "../format";
import { copasAbi, deployment, isDeployed, perpIdsForChain, type Leader } from "./contracts";
import { leaderStats } from "./indexer";

const client = createPublicClient({ chain: copasChain, transport: rpcTransport(copasChain) });
const STATUS = ["active", "unbonded", "breached", "closed"] as const;
const ZERO = "0x0000000000000000000000000000000000000000";
const A = (v: unknown) => Number(v as bigint) / 1e6;
const lbOf = (book: `0x${string}`) => ({ address: book, abi: copasAbi.LeaderBook as Abi });

/** Leaders from CopasRegistry. Null when the chain read fails; empty before contracts are deployed. */
export async function getLeaders(): Promise<Leader[] | null> {
  if (!isDeployed) return [];
  // 20 s shared cache: every page renders the registry, and per-request reads hit public RPC rate limits.
  // A failed read throws inside, so it is never cached.
  return cachedLeaders().catch(() => null);
}

const cachedLeaders = unstable_cache(
  async (): Promise<Leader[]> => {
    const reg = { address: deployment!.registry!, abi: copasAbi.CopasRegistry as Abi };
    const n = Number(await client.readContract({ ...reg, functionName: "leaderCount" }));
    const [books, stats] = await Promise.all([
      client.multicall({ contracts: Array.from({ length: n }, (_, i) => ({ ...reg, functionName: "leaderBooks", args: [BigInt(i)] })), allowFailure: false }) as Promise<`0x${string}`[]>,
      leaderStats(),
    ]);
    return Promise.all(books.map((b) => readLeader(b, stats)));
  },
  ["copas-leaders"],
  { revalidate: 20 },
);

/** One LeaderBook, or null when the address is not a Copas leader (or the read fails). */
export async function getLeader(book: string): Promise<Leader | null> {
  if (!isDeployed || !/^0x[0-9a-fA-F]{40}$/.test(book)) return null;
  try {
    const ok = await client.readContract({ address: deployment!.registry!, abi: copasAbi.CopasRegistry as Abi, functionName: "isLeaderBook", args: [book] });
    if (!ok) return null;
    return await readLeader(book as `0x${string}`, await leaderStats());
  } catch {
    return null;
  }
}

/** CopasRegistry.maxVaultDepositCNS in AUSD; null when unreadable (0 on chain = no cap). */
export async function maxVaultDeposit(): Promise<number | null> {
  if (!deployment?.registry) return null;
  return client.readContract({ address: deployment.registry, abi: copasAbi.CopasRegistry as Abi, functionName: "maxVaultDepositCNS" }).then(A, () => null);
}

/** Perpl's minimum first deposit (getMinAccountOpenCNS) in AUSD: a vault's first deposit opens its Perpl account. Null when unreadable. */
export async function minVaultOpen(): Promise<number | null> {
  const ex = (deployment as { exchange?: `0x${string}` } | undefined)?.exchange;
  if (!ex) return null;
  return client.readContract({ address: ex, abi: parseAbi(["function getMinAccountOpenCNS() view returns (uint256)"]), functionName: "getMinAccountOpenCNS" }).then(A, () => null);
}

/** Live LeaderBook equity/unit/peak, or null when the address is not a Copas LeaderBook. Throws on RPC failure. */
export async function leaderBookLive(book: `0x${string}`) {
  if (!deployment?.registry) return null;
  if (!(await client.readContract({ address: deployment.registry, abi: copasAbi.CopasRegistry as Abi, functionName: "isLeaderBook", args: [book] }))) return null;
  const lb = lbOf(book);
  const [eq, unit, peak] = (await client.multicall({ contracts: (["equity", "unitPrice", "peakUnitPrice"] as const).map((f) => ({ ...lb, functionName: f })), allowFailure: false })) as [[bigint, boolean], [bigint, boolean], bigint];
  const equity = A(eq[0]);
  const u = Number(unit[0]) / 1e18;
  return { equity, valid: eq[1] && unit[1], unit: u, units: u ? equity / u : 0, peak: Number(peak) / 1e18 };
}

async function readLeader(book: `0x${string}`, stats: Awaited<ReturnType<typeof leaderStats>>): Promise<Leader> {
  const lb = lbOf(book);
  const fns = ["owner", "status", "bond", "mandate", "unitPrice", "peakUnitPrice", "epoch", "epochEnd", "capacity", "capTotalNext", "pool", "operator", "equity"] as const;
  const r = (await client.multicall({ contracts: fns.map((f) => ({ ...lb, functionName: f })), allowFailure: false })) as unknown[];
  const [owner, status, bond, mandate, unit, peak, epoch, epochEnd, capacity, capTotal, pool, operator, equity] = r;
  const m = mandate as RawMandate;
  const u = Number((unit as [bigint, boolean])[0]) / 1e18;
  const pk = Number(peak as bigint) / 1e18;
  const hasPool = pool && pool !== ZERO;
  const [uw, agentId, nad] = await Promise.all([
    hasPool ? client.readContract({ address: pool as `0x${string}`, abi: copasAbi.UnderwriterPool as Abi, functionName: "assets" }).then(A) : 0,
    deployment?.agentRegistry
      ? (client.readContract({ address: deployment.agentRegistry, abi: copasAbi.AgentLeaderRegistry as Abi, functionName: "agentOf", args: [book] }) as Promise<bigint>).catch(() => 0n)
      : 0n,
    nadName(owner as `0x${string}`),
  ]);
  const agentName = agentId ? await erc8004Name(agentId) : undefined;
  const names = Object.keys(perpIdsForChain());
  return {
    book,
    owner: owner as `0x${string}`,
    name: agentName ?? nad ?? short(book),
    agent: agentId
      ? { erc8004Id: Number(agentId), model: `operator ${short(String(operator))}` }
      : operator !== owner
        ? { erc8004Id: 0, model: `operator ${short(String(operator))}` }
        : undefined,
    status: STATUS[Number(status)] ?? "closed",
    bond: A(bond),
    underwritten: uw,
    pool: hasPool ? (pool as `0x${string}`) : null,
    maxDD: m.maxDDbps / 100,
    liveDD: pk > 0 ? Math.max(0, (1 - u / pk) * 100) : 0,
    unitPrice: u,
    peakUnitPrice: pk,
    equity: A((equity as [bigint, boolean])[0]),
    epoch: Number(epoch),
    epochEnd: Number(epochEnd) * 1000,
    epochLenH: Number(m.epochLen) / 3600,
    followerAum: A(capTotal),
    followers: stats?.get(book.toLowerCase())?.followers ?? (stats ? 0 : null),
    capacity: A(capacity),
    maxLeverage: m.maxLeverageHdths / 100,
    maxNotional: A(m.maxNotionalCNS),
    markets: names.filter((_, i) => (m.marketsMask >> BigInt(i)) & 1n),
    feePct: m.feeBps / 100,
    returnTotal: (u - 1) * 100,
    perplAccount: book,
  };
}

type RawMandate = { maxDDbps: number; maxLeverageHdths: number; feeBps: number; epochLen: bigint; maxNotionalCNS: bigint; marketsMask: bigint };
export type MandateView = { maxDD: number; maxLeverage: number; feePct: number; maxNotional: number; markets: string[]; epochLenH: number; raw: RawMandate };
const mandateView = (m: RawMandate): MandateView => ({
  maxDD: m.maxDDbps / 100,
  maxLeverage: m.maxLeverageHdths / 100,
  feePct: m.feeBps / 100,
  maxNotional: A(m.maxNotionalCNS),
  markets: Object.keys(perpIdsForChain()).filter((_, i) => (m.marketsMask >> BigInt(i)) & 1n),
  epochLenH: Number(m.epochLen) / 3600,
  raw: m,
});
/** Same rule as FollowerVault._within: is `m` looser than `a` on any term a follower agreed to? */
export const looserThan = (m: RawMandate, a: RawMandate) =>
  m.feeBps > a.feeBps || m.maxDDbps > a.maxDDbps || m.maxLeverageHdths > a.maxLeverageHdths || m.maxNotionalCNS > a.maxNotionalCNS || (m.marketsMask & ~a.marketsMask) !== 0n;

/** A mandate change the leader declared; it goes live at the next epoch roll (LeaderBook.declare). */
export async function pendingMandate(book: `0x${string}`) {
  const lb = lbOf(book);
  const [has, pend, cur, epoch] = (await client.multicall({ contracts: (["hasPendingMandate", "pendingMandate", "mandate", "epoch"] as const).map((f) => ({ ...lb, functionName: f })), allowFailure: false })) as [boolean, RawMandate, RawMandate, bigint];
  if (!has) return null;
  return { next: mandateView(pend), current: mandateView(cur), looser: looserThan(pend, cur), effectiveEpoch: Number(epoch) + 1 };
}

const reputationAbi = parseAbi([
  "function getClients(uint256 agentId) view returns (address[])",
  "function readAllFeedback(uint256 agentId, address[] clientAddresses, string tag1, string tag2, bool includeRevoked) view returns (address[] clients, uint64[] feedbackIndexes, int128[] values, uint8[] valueDecimals, string[] tag1s, string[] tag2s, bool[] revokedStatuses)",
]);
/** ERC-8004 ReputationRegistry v2 (same address on every testnet deployment of the reference registries). */
export const REPUTATION_8004 = copasChain.id === 143 ? "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" : "0x8004B663056A597Dffe9eCcC1965A193B7388713";

/** All unrevoked feedback an ERC-8004 agent received, from every client (Copas keeper writes tag1 "copas", one per epoch). */
export async function agentReputation(agentId: number) {
  try {
    const id = BigInt(agentId);
    const clients = await client.readContract({ address: REPUTATION_8004, abi: reputationAbi, functionName: "getClients", args: [id] });
    if (!clients.length) return { count: 0, avg: null, clients: 0, entries: [] };
    const [cs, idx, vals, decs, t1, t2] = await client.readContract({ address: REPUTATION_8004, abi: reputationAbi, functionName: "readAllFeedback", args: [id, clients, "", "", false] });
    const entries = cs.map((c, i) => ({ client: c, index: Number(idx[i]), value: Number(vals[i]) / 10 ** decs[i], tag1: t1[i], tag2: t2[i] }));
    return { count: entries.length, avg: entries.reduce((a, e) => a + e.value, 0) / entries.length, clients: clients.length, entries };
  } catch {
    return null;
  }
}

/**
 * Nad Name Service primary name (docs.nad.domains → Contract addresses, Monad mainnet NadNameService). Read on mainnet even for
 * testnet leaders: an EOA owner is the same key on both chains, and the testnet NNS deployment has no code. Forward-verified
 * (name → address must round-trip) so a primary name someone set for an address they don't own never shows.
 */
const NNS = "0xCc7a1bfF8845573dbF0B3b96e25B9b549d4a2eC7";
const nnsAbi = parseAbi(["function getPrimaryNameForAddress(address) view returns (string)", "function getResolvedAddress(bytes32) view returns (address)"]);
const mainnet = createPublicClient({ chain: monad, transport: http() });
async function nadName(addr: `0x${string}`): Promise<string | undefined> {
  try {
    const n = (await mainnet.readContract({ address: NNS, abi: nnsAbi, functionName: "getPrimaryNameForAddress", args: [addr] })).trim();
    if (!n || n.length > 40) return;
    const name = normalize(`${n}.nad`);
    const back = await mainnet.readContract({ address: NNS, abi: nnsAbi, functionName: "getResolvedAddress", args: [namehash(name)] });
    return back.toLowerCase() === addr.toLowerCase() ? name : undefined;
  } catch {
    return;
  }
}

const MAX_META = 64 * 1024;

/**
 * ERC-8004 registration file `name`. tokenURI is attacker-controlled (anyone can register an agent), so only
 * data:application/json (decoded inline) and ipfs:// (fixed gateway, no redirects, size-capped) are read; anything else is ignored.
 */
async function erc8004Name(id: bigint): Promise<string | undefined> {
  if (!deployment?.identity8004) return;
  try {
    const uri = (await client.readContract({ address: deployment.identity8004, abi: erc721Abi, functionName: "tokenURI", args: [id] })).trim();
    let text: string;
    if (/^data:application\/json[;,]/i.test(uri)) {
      const comma = uri.indexOf(",");
      const head = uri.slice(0, comma);
      const body = uri.slice(comma + 1);
      text = /;base64$/i.test(head) ? Buffer.from(body, "base64").toString() : decodeURIComponent(body);
    } else if (uri.startsWith("ipfs://")) {
      const path = uri.slice(7).replace(/^ipfs\//, "");
      if (!/^[A-Za-z0-9]+(\/[A-Za-z0-9._-]+)*$/.test(path)) return; // CID plus plain path segments only
      const res = await fetch(`https://ipfs.io/ipfs/${path.split("/").map(encodeURIComponent).join("/")}`, { redirect: "error", signal: AbortSignal.timeout(5000), next: { revalidate: 3600 } });
      if (!res.ok || Number(res.headers.get("content-length") ?? 0) > MAX_META) return;
      text = await res.text();
    } else return;
    if (text.length > MAX_META) return;
    const name = (JSON.parse(text) as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : undefined;
  } catch {
    return;
  }
}

/* ----------------------------- Perpl positions ----------------------------- */

const ex = { address: PERPL[copasChain.id].exchange, abi: perplExchangeAbi } as const;
type RegMarket = { perpId: number; priceDecimals: number; lotDecimals: number };

/** Open Perpl positions of a LeaderBook or FollowerVault (both own one Perpl account, both expose accountId()). */
export async function perplPositions(owner: `0x${string}`): Promise<Position[]> {
  if (!deployment?.registry) return [];
  const [acct, mkts] = (await client.multicall({
    contracts: [
      { ...lbOf(owner), functionName: "accountId" },
      { address: deployment.registry, abi: copasAbi.CopasRegistry as Abi, functionName: "markets" },
    ],
    allowFailure: false,
  })) as [bigint, RegMarket[]];
  if (!acct) return [];
  const names = Object.fromEntries(Object.entries(perpIdsForChain()).map(([k, id]) => [id, k]));
  const res = await client.multicall({ contracts: mkts.map((m) => ({ ...ex, functionName: "getPosition", args: [BigInt(m.perpId), acct] }) as const), allowFailure: false });
  return res.flatMap(([p, mark], i) => {
    const m = mkts[i];
    // maintLev 0: testnet maintenance margin is not in the registry, so no liquidation estimate
    return p.lotLNS > 0n ? [toPosition({ id: m.perpId, name: names[m.perpId] ?? String(m.perpId), pd: m.priceDecimals, sd: m.lotDecimals, maintLev: 0 }, p as RawPos, mark)] : [];
  });
}

/* ------------------------------ follower vault ------------------------------ */

/** Live vault state from chain. `owner` resolves to the newest vault in CopasRegistry.vaultsOf. */
export async function vaultState({ owner, vault }: { owner?: string; vault?: string }) {
  if (!deployment?.registry) return null;
  try {
    let v = vault as `0x${string}` | undefined;
    if (!v && owner) {
      const vs = (await client.readContract({ address: deployment.registry, abi: copasAbi.CopasRegistry as Abi, functionName: "vaultsOf", args: [owner] })) as `0x${string}`[];
      v = vs[vs.length - 1];
    }
    if (!v) return null;
    const fv = { address: v, abi: copasAbi.FollowerVault as Abi };
    const fns = ["owner", "leader", "following", "equity", "highWaterMark", "paused", "params"] as const;
    const [vOwner, leader, following, eq, hwm, paused, params] = (await client.multicall({ contracts: fns.map((f) => ({ ...fv, functionName: f })), allowFailure: false })) as unknown[];
    const p = params as { ratioBps: number; maxLeverageHdths: number; stopLossBps: number };
    const lead = following && leader !== ZERO ? (leader as `0x${string}`) : null;
    const [positions, leaderPositions, claimable, consent] = await Promise.all([perplPositions(v), lead ? perplPositions(lead) : [], lead ? chainClaimable(lead, v) : [], lead ? vaultConsent(v, lead) : null]);
    return {
      vault: v,
      owner: vOwner as `0x${string}`,
      leader: lead,
      equity: A((eq as [bigint, boolean])[0]),
      hwm: A(hwm),
      paused: paused as boolean,
      params: { ratioPct: p.ratioBps / 100, maxLeverage: p.maxLeverageHdths / 100, stopLossPct: p.stopLossBps / 100 },
      positions,
      leaderPositions,
      claimable,
      consent,
    };
  } catch {
    return null;
  }
}
export type VaultState = NonNullable<Awaited<ReturnType<typeof vaultState>>>;

/**
 * Mandate consent of a vault (vaults from the 12 Oct VaultFactory). `ok` false = the leader's live mandate is looser than what the
 * owner accepted, so sync targets 0 until acceptMandate. Null for older vaults, which have no consent check.
 */
async function vaultConsent(vault: `0x${string}`, book: `0x${string}`) {
  const fv = { address: vault, abi: copasAbi.FollowerVault as Abi };
  const r = await client.multicall({ contracts: [{ ...fv, functionName: "accepted" }, { ...fv, functionName: "consentOk" }], allowFailure: true });
  if (r[0].status !== "success" || r[1].status !== "success") return null;
  const accepted = r[0].result as RawMandate;
  const pending = await pendingMandate(book).catch(() => null);
  const live = (await client.readContract({ ...lbOf(book), functionName: "mandate" })) as RawMandate;
  return {
    ok: r[1].result as boolean,
    accepted: mandateView(accepted),
    live: mandateView(live),
    // a looser pending change this vault has not pre-accepted: it will stop copying at the next roll
    pending: pending && looserThan(pending.next.raw, accepted) ? pending : null,
  };
}

/** Unclaimed breaches of the current leader for this vault (estimate before min(·, actual loss)). */
async function chainClaimable(book: `0x${string}`, vault: `0x${string}`) {
  const lb = lbOf(book);
  const e = Number(await client.readContract({ ...lb, functionName: "epoch" }));
  const epochs = Array.from({ length: e }, (_, i) => i + 1);
  const res = (await client.multicall({
    contracts: [{ ...lb, functionName: "capOf", args: [vault] }, ...epochs.flatMap((x) => [{ ...lb, functionName: "breachOf", args: [BigInt(x)] }, { ...lb, functionName: "claimed", args: [BigInt(x), vault] }])],
    allowFailure: false,
  })) as unknown[];
  const cap = A(res[0]);
  return epochs.flatMap((x, i) => {
    const b = res[1 + i * 2] as { reason: number; pot: bigint; capTotal: bigint; swept: boolean };
    const done = res[2 + i * 2] as boolean;
    if (!b.reason || b.swept || done) return [];
    return [{ book, epoch: x, estimate: b.capTotal ? (A(b.pot) * cap) / A(b.capTotal) : 0 }];
  });
}

const synced = parseAbiItem("event Synced(uint256 indexed perpId, int256 leaderLot, int256 fromLot, int256 targetLot, uint256 mark)");

/** Synced events of a vault from RPC, newest first. ponytail: testnet RPC caps getLogs at 100 blocks, so only the last ~1000 blocks; the indexer has full history. */
export async function recentSynced(vault: `0x${string}`, blocks = 1000n) {
  if (!deployment?.registry) return [];
  const head = await client.getBlockNumber();
  const ranges = Array.from({ length: Number(blocks / 100n) }, (_, i) => head - BigInt(i + 1) * 100n + 1n);
  const [logs, mkts] = await Promise.all([
    Promise.all(ranges.map((from) => client.getLogs({ address: vault, event: synced, fromBlock: from, toBlock: from + 99n }).catch(() => []))).then((x) => x.flat()),
    client.readContract({ address: deployment.registry, abi: copasAbi.CopasRegistry as Abi, functionName: "markets" }) as Promise<RegMarket[]>,
  ]);
  if (!logs.length) return [];
  const names = Object.fromEntries(Object.entries(perpIdsForChain()).map(([k, id]) => [id, k]));
  const times = new Map<bigint, number>();
  await Promise.all([...new Set(logs.map((l) => l.blockNumber))].map(async (b) => times.set(b, Number((await client.getBlock({ blockNumber: b })).timestamp) * 1000)));
  return logs
    .map((l) => {
      const id = Number(l.args.perpId);
      const m = mkts.find((x) => x.perpId === id);
      const lot = (x?: bigint) => Number(x ?? 0n) / 10 ** (m?.lotDecimals ?? 0);
      return {
        t: times.get(l.blockNumber) ?? 0,
        market: names[id] ?? String(id),
        leaderLot: lot(l.args.leaderLot),
        from: lot(l.args.fromLot),
        target: lot(l.args.targetLot),
        mark: Number(l.args.mark ?? 0n) / 10 ** (m?.priceDecimals ?? 0),
        block: Number(l.blockNumber),
        tx: l.transactionHash as string,
      };
    })
    .sort((a, b) => b.block - a.block);
}

/* ---------------------------------- proof ---------------------------------- */

const checkpointEv = parseAbiItem("event Checkpoint(uint256 indexed epoch, uint256 equity, uint256 unitPrice, uint256 peak, uint256 ddBps, uint256 leverageHdths)");

/**
 * The inputs the contract used for one breach: the breaching Checkpoint log (same block as Breached),
 * breachOf(e) and the mandate. `claim` (a vault and its paid amount) fills the per-follower half.
 */
export async function breachInputs(book: `0x${string}`, e: number, claim?: { vault: `0x${string}`; amount: number }) {
  try {
    const lb = lbOf(book);
    const [b, mandate, cap] = (await client.multicall({
      contracts: [{ ...lb, functionName: "breachOf", args: [BigInt(e)] }, { ...lb, functionName: "mandate" }, { ...lb, functionName: claim ? "capOf" : "epochCapTotal", args: [claim ? claim.vault : BigInt(e)] }],
      allowFailure: false,
    })) as [{ reason: number; atBlock: bigint; pot: bigint; capTotal: bigint; claimed: bigint }, { maxDDbps: number }, bigint];
    if (!b.reason) return null;
    const [cp] = await client.getLogs({ address: book, event: checkpointEv, args: { epoch: BigInt(e) }, fromBlock: b.atBlock, toBlock: b.atBlock });
    if (!cp) return null;
    const equity = A(cp.args.equity);
    const unit = Number(cp.args.unitPrice!) / 1e18;
    return {
      book,
      epoch: e,
      block: Number(b.atBlock),
      equity,
      units: unit ? equity / unit : 0,
      peak: Number(cp.args.peak!) / 1e18,
      maxDD: mandate.maxDDbps / 100,
      slash: A(b.pot),
      capTotal: A(b.capTotal),
      // without a known claim the example covers all followers at once: Σcap and Σclaimed
      cap: A(cap),
      loss: claim?.amount ?? A(b.claimed),
      vault: claim?.vault,
    };
  } catch {
    return null;
  }
}

/** Live UP/DOWN series for this or next epoch, plus Kuru top of book when DOWN is listed. Null = nothing minted yet. */
const bookAbi = [{ type: "function", name: "bestBidAsk", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }, { type: "uint256" }] }] as const;
// Kuru V1 testnet router: market addresses are deterministic (CREATE2 over the market params), so the DOWN/AUSD book
// the keeper market maker (keeper/src/mm.ts) lists with the defaults below is found without logs or a registry.
const KURU_ROUTER = "0x7EFbE105Ca7415dE98F96622173458ac1c054630";
const kuruAbi = parseAbi([
  "function computeAddress(address base, address quote, uint96 sizePrecision, uint32 pricePrecision, uint32 tickSize, uint96 minSize, uint96 maxSize, uint256 takerFeeBps, uint256 makerFeeBps, uint96 kuruAmmSpread, address oldImplementation, bool old) view returns (address)",
]);
async function kuruMarket(down: `0x${string}`): Promise<`0x${string}` | undefined> {
  if (copasChain.id !== 10143 || !deployment?.ausd) return undefined; // mainnet Kuru listing is permissioned
  const m = await client.readContract({
    address: KURU_ROUTER, abi: kuruAbi, functionName: "computeAddress",
    args: [down, deployment.ausd, 100n, 10_000, 10, 100n, 10n ** 12n, 30n, 10n, 100n, ZERO, false],
  });
  return (await client.getCode({ address: m })) ? m : undefined;
}
export async function getDownMarket(book: string, epoch: number) {
  if (!deployment?.breachMarket) return null;
  const bm = { address: deployment.breachMarket, abi: copasAbi.BreachMarket as Abi };
  for (const e of [epoch, epoch + 1]) {
    const s = (await client.readContract({ ...bm, functionName: "series", args: [book, BigInt(e)] }).catch(() => null)) as
      | { up: `0x${string}`; down: `0x${string}`; settled: boolean; breach: boolean }
      | null;
    if (!s || s.down === ZERO) continue;
    const supply = A(await client.readContract({ address: s.down, abi: copasAbi.BreachToken as Abi, functionName: "totalSupply" }));
    const market = await kuruMarket(s.down).catch(() => undefined);
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
