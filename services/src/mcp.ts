/**
 * MCP server (Streamable HTTP, stateless, JSON responses) at POST /mcp, so AI agents can use Copas.
 * Read-only: no tool holds or asks for a private key.
 *  - Onchain tools read Copas on Monad testnet (10143) with viem: registry -> leader books, vaults, mandates, bonds.
 *  - Data tools run the same Hono routes as the HTTP API (stats, backtest, analysis, alignment, discover, attest, simulate).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type Address, createPublicClient, formatUnits, http, parseAbi } from "viem";
import { monadTestnet } from "viem/chains";
import { z } from "zod";
import { type Fetch, rpcUrl } from "./util.js";

/** contracts/deployments/10143.json `registry`; factories, leader books and vaults are all read from it onchain. */
export const REGISTRY: Address = "0xA8BA57c7Af1d9A28660653E0439A180c86D03e3d";
const STATUS = ["Active", "Unbonded", "Breached"] as const;

export const COPAS_ABI = parseAbi([
  "struct Mandate { uint32 maxDDbps; uint32 maxLeverageHdths; uint32 feeBps; uint64 epochLen; uint128 maxNotionalCNS; uint256 marketsMask; }",
  "struct FollowParams { uint32 ratioBps; uint32 maxLeverageHdths; uint32 maxChaseBps; uint32 priceBandBps; uint32 stopLossBps; uint128 maxNotionalCNS; uint256 marketsMask; }",
  "struct Market { uint32 perpId; uint8 priceDecimals; uint8 lotDecimals; }",
  // CopasRegistry
  "function leaderCount() view returns (uint256)",
  "function leaderBooks(uint256) view returns (address)",
  "function isLeaderBook(address) view returns (bool)",
  "function isVault(address) view returns (bool)",
  "function vaultsOf(address) view returns (address[])",
  "function leadersOf(address) view returns (address[])",
  "function leaderFactory() view returns (address)",
  "function vaultFactory() view returns (address)",
  "function markets() view returns (Market[])",
  "function maxVaultDepositCNS() view returns (uint256)",
  "function minBondAbsCNS() view returns (uint256)",
  "function bondRatioBps() view returns (uint256)",
  "function kEquity() view returns (uint256)",
  "function protocolFeeBps() view returns (uint256)",
  "function uwFeeShareBps() view returns (uint256)",
  "function claimWindowEpochs() view returns (uint256)",
  // LeaderBook (+ owner/accountId/equity/highWaterMark shared with FollowerVault)
  "function owner() view returns (address)",
  "function operator() view returns (address)",
  "function accountId() view returns (uint256)",
  "function status() view returns (uint8)",
  "function epoch() view returns (uint256)",
  "function epochStart() view returns (uint64)",
  "function epochEnd() view returns (uint64)",
  "function units() view returns (uint256)",
  "function bond() view returns (uint256)",
  "function feeEscrow() view returns (uint256)",
  "function capTotalNext() view returns (uint256)",
  "function peakUnitPrice() view returns (uint256)",
  "function hasPendingMandate() view returns (bool)",
  "function mandate() view returns (Mandate)",
  "function pendingMandate() view returns (Mandate)",
  "function equity() view returns (uint256 eq, bool valid)",
  "function unitPrice() view returns (uint256 u, bool valid)",
  "function minBond() view returns (uint256)",
  "function capacity() view returns (uint256)",
  "function protection() view returns (uint256)",
  "function pool() view returns (address)",
  // FollowerVault
  "function leader() view returns (address)",
  "function following() view returns (bool)",
  "function paused() view returns (bool)",
  "function params() view returns (FollowParams)",
  "function accepted() view returns (Mandate)",
  "function consentOk() view returns (bool)",
  "function highWaterMark() view returns (uint256)",
  "function referrer() view returns (address)",
  "function epochSeen() view returns (uint256)",
]);

const ausd = (x: bigint) => Number(formatUnits(x, 6)); // AUSD and Perpl CNS amounts have 6 decimals
const mask = (m: bigint) => [...m.toString(2)].reverse().flatMap((b, i) => (b === "1" ? [i] : []));
const mandateOut = (m: any) =>
  m && { maxDrawdownPct: m.maxDDbps / 100, maxLeverage: m.maxLeverageHdths / 100, performanceFeePct: m.feeBps / 100, epochLenSec: Number(m.epochLen), maxNotionalAUSD: ausd(m.maxNotionalCNS), allowedMarketIndexes: mask(m.marketsMask) };

export function chainReader(f?: Fetch) {
  const client = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl(monadTestnet.id), { fetchFn: f, retryCount: 1, timeout: 10_000 }) });
  /** One multicall; a reverting view (e.g. `accepted` on a pre-consent vault) comes back as null instead of failing the read. */
  const read = async (address: Address, fns: string[], args: Record<string, readonly unknown[]> = {}) => {
    const rs = await client.multicall({ contracts: fns.map((functionName) => ({ address, abi: COPAS_ABI, functionName, args: args[functionName] ?? [] }) as any), allowFailure: true });
    return Object.fromEntries(fns.map((fn, i) => [fn, rs[i].status === "success" ? (rs[i].result as any) : null])) as Record<string, any>;
  };

  const leader = async (lb: Address) => {
    const [reg, r] = await Promise.all([
      read(REGISTRY, ["isLeaderBook"], { isLeaderBook: [lb] }),
      read(lb, ["owner", "operator", "accountId", "status", "epoch", "epochStart", "epochEnd", "units", "bond", "feeEscrow", "capTotalNext", "peakUnitPrice", "hasPendingMandate", "mandate", "pendingMandate", "equity", "unitPrice", "minBond", "capacity", "protection", "pool"]),
    ]);
    if (!reg.isLeaderBook) throw new Error(`${lb} is not a Copas LeaderBook in registry ${REGISTRY}`);
    return {
      leaderBook: lb,
      owner: r.owner,
      operator: r.operator,
      perplAccountId: r.accountId?.toString(),
      status: STATUS[r.status] ?? r.status,
      epoch: Number(r.epoch),
      epochStart: Number(r.epochStart),
      epochEnd: Number(r.epochEnd),
      mandate: mandateOut(r.mandate),
      pendingMandate: r.hasPendingMandate ? mandateOut(r.pendingMandate) : null,
      bondAUSD: ausd(r.bond),
      minBondAUSD: r.minBond == null ? null : ausd(r.minBond),
      feeEscrowAUSD: ausd(r.feeEscrow),
      protectionAUSD: r.protection == null ? null : ausd(r.protection),
      followerCapTotalAUSD: ausd(r.capTotalNext),
      capacityAUSD: r.capacity == null ? null : ausd(r.capacity),
      equityAUSD: r.equity ? ausd(r.equity[0]) : null,
      equityValid: r.equity ? r.equity[1] : null,
      unitPrice: r.unitPrice ? Number(formatUnits(r.unitPrice[0], 18)) : null,
      peakUnitPrice: r.peakUnitPrice == null ? null : Number(formatUnits(r.peakUnitPrice, 18)),
      units: r.units?.toString(),
      underwriterPool: r.pool,
      app: `https://copas-mocha.vercel.app/leader/${lb}`,
    };
  };

  return {
    async protocol() {
      const r = await read(REGISTRY, ["leaderCount", "leaderFactory", "vaultFactory", "markets", "maxVaultDepositCNS", "minBondAbsCNS", "bondRatioBps", "kEquity", "protocolFeeBps", "uwFeeShareBps", "claimWindowEpochs"]);
      return {
        chainId: monadTestnet.id,
        registry: REGISTRY,
        leaderFactory: r.leaderFactory,
        vaultFactory: r.vaultFactory,
        leaderCount: Number(r.leaderCount),
        markets: (r.markets ?? []).map((m: any, index: number) => ({ index, perpId: m.perpId, priceDecimals: m.priceDecimals, lotDecimals: m.lotDecimals })),
        maxVaultDepositAUSD: ausd(r.maxVaultDepositCNS),
        minBondAUSD: ausd(r.minBondAbsCNS),
        bondRatioPct: Number(r.bondRatioBps) / 100,
        followerAumMaxTimesLeaderEquity: Number(r.kEquity),
        protocolFeePct: Number(r.protocolFeeBps) / 100,
        underwriterFeeSharePct: Number(r.uwFeeShareBps) / 100,
        claimWindowEpochs: Number(r.claimWindowEpochs),
      };
    },
    async listLeaders(limit = 25) {
      const n = Number((await read(REGISTRY, ["leaderCount"])).leaderCount);
      const ids = Array.from({ length: Math.min(n, limit) }, (_, i) => BigInt(i));
      const books = await client.multicall({ contracts: ids.map((i) => ({ address: REGISTRY, abi: COPAS_ABI, functionName: "leaderBooks", args: [i] }) as const), allowFailure: false });
      return { leaderCount: n, leaders: await Promise.all((books as Address[]).map(leader)) };
    },
    leader,
    async vault(v: Address) {
      const [reg, r] = await Promise.all([
        read(REGISTRY, ["isVault"], { isVault: [v] }),
        read(v, ["owner", "leader", "following", "paused", "params", "accepted", "consentOk", "equity", "highWaterMark", "referrer", "accountId", "epochSeen"]),
      ]);
      if (!reg.isVault) throw new Error(`${v} is not a Copas FollowerVault in registry ${REGISTRY}`);
      const p = r.params;
      return {
        vault: v,
        owner: r.owner,
        leaderBook: r.leader,
        following: r.following,
        stopLossPaused: r.paused,
        equityAUSD: r.equity ? ausd(r.equity[0]) : null,
        equityValid: r.equity ? r.equity[1] : null,
        highWaterMarkAUSD: r.highWaterMark == null ? null : ausd(r.highWaterMark),
        followParams: p && { copyRatioPct: p.ratioBps / 100, maxLeverage: p.maxLeverageHdths / 100, maxChasePct: p.maxChaseBps / 100, priceBandPct: p.priceBandBps / 100, stopLossPct: p.stopLossBps / 100, maxNotionalAUSD: ausd(p.maxNotionalCNS), allowedMarketIndexes: mask(p.marketsMask) },
        // null on vaults from the first VaultFactory (no mandate consent)
        acceptedMandate: mandateOut(r.accepted),
        consentOk: r.consentOk,
        referrer: r.referrer,
        perplAccountId: r.accountId?.toString(),
        epochSeen: r.epochSeen == null ? null : Number(r.epochSeen),
      };
    },
    async owner(o: Address) {
      const r = await read(REGISTRY, ["vaultsOf", "leadersOf"], { vaultsOf: [o], leadersOf: [o] });
      return { owner: o, vaults: r.vaultsOf ?? [], leaderBooks: r.leadersOf ?? [] };
    },
  };
}

type Call = (path: string, init?: RequestInit) => Response | Promise<Response>;
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const ok = (v: unknown) => ({ content: [{ type: "text" as const, text: json(v) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: e instanceof Error ? e.message : json(e) }], isError: true });
const run = async (p: Promise<unknown>) => p.then(ok, fail);
/** Same route, same logic as the HTTP API; a non-2xx answer becomes an MCP tool error carrying the JSON body. */
const route = async (call: Call, path: string, init?: RequestInit) => {
  const r = await call(path, init);
  const body = await r.json().catch(() => ({ status: r.status }));
  return r.ok ? ok(body) : fail({ status: r.status, ...body });
};

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "0x-prefixed 20-byte address");
const days = z.number().int().min(1).max(365).optional().describe("lookback window in days (default 30)");
const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: true } as const;

export function createMcpServer(call: Call, f?: Fetch) {
  const s = new McpServer({ name: "copas", version: "0.1.0" }, { instructions: "Copas: bonded copy-trading over Perpl perps on Monad. Leaders post a bond against a public mandate (max drawdown, leverage, notional, markets, fee); breaking it slashes the bond to followers. Use copas_* tools for live onchain state on Monad testnet (10143) and perpl_* tools to judge a trader before following. All tools are read-only." });
  const chain = chainReader(f);

  s.registerTool("copas_protocol", { title: "Copas protocol parameters", description: "Live CopasRegistry state on Monad testnet: factories, leader count, allowed Perpl markets, bond ratio, deposit cap, fee splits.", inputSchema: {}, annotations: RO }, () => run(chain.protocol()));
  s.registerTool("copas_list_leaders", { title: "List Copas leaders", description: "Every leader registered onchain (LeaderBook contracts): status, epoch, mandate, bond, protection, equity, unit price, follower capacity.", inputSchema: { limit: z.number().int().min(1).max(100).optional().describe("max leaders (default 25)") }, annotations: RO }, ({ limit }) => run(chain.listLeaders(limit)));
  s.registerTool("copas_get_leader", { title: "Copas leader (onchain)", description: "One LeaderBook's live onchain state: owner/operator, status (Active/Unbonded/Breached), epoch window, current and pending mandate, bond vs min bond, fee escrow, underwriter protection, equity, unit price, capacity.", inputSchema: { leaderBook: addr.describe("LeaderBook address") }, annotations: RO }, ({ leaderBook }) => run(chain.leader(leaderBook as Address)));
  s.registerTool("copas_get_vault", { title: "Copas follower vault (onchain)", description: "One FollowerVault's live state: owner, followed leader, copy params (ratio, caps, stop-loss), accepted mandate and whether consent still holds, equity, high-water mark.", inputSchema: { vault: addr.describe("FollowerVault address") }, annotations: RO }, ({ vault }) => run(chain.vault(vault as Address)));
  s.registerTool("copas_get_owner", { title: "Copas positions of a wallet", description: "Vaults and LeaderBooks a wallet owns, from the registry.", inputSchema: { owner: addr.describe("wallet address") }, annotations: RO }, ({ owner }) => run(chain.owner(owner as Address)));

  const q = (d?: number) => (d ? `?days=${d}` : "");
  s.registerTool("perpl_leader_stats", { title: "Trader track record", description: "Perpl trading record of a wallet (mainnet trader) or Copas LeaderBook (testnet): official 30d PnL/ROI, closed trades, win rate, max drawdown, leverage, open positions.", inputSchema: { address: addr, days }, annotations: RO }, ({ address, days }) => route(call, `/leader/${address}/stats${q(days)}`));
  s.registerTool("perpl_backtest", { title: "Backtest copying a trader", description: "Deterministic replay of the trader's real fills through Copas rules (vault sync, caps, fees, slippage, mandate breaches, bond claims). Returns the follower equity curve, drawdown, fees and compensation.", inputSchema: { address: addr, days, follower: z.object({ depositCNS: z.number(), ratioBps: z.number(), maxNotionalCNS: z.number(), maxLeverageHdths: z.number(), maxChaseBps: z.number(), priceBandBps: z.number(), stopLossBps: z.number() }).partial().optional().describe("follower settings (AUSD amounts, bps, leverage in hundredths)"), mandate: z.object({ maxDDbps: z.number(), epochLen: z.number() }).partial().optional() }, annotations: RO }, ({ address, ...body }) => route(call, `/leader/${address}/backtest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  s.registerTool("perpl_leader_analysis", { title: "AI risk analysis of a trader", description: "LLM risk analyst over deterministic features (style, tilt, drift, reasons not to follow) with a signed EIP-191 receipt. Can take ~20 s; degrades to the deterministic features when the LLM quota is out.", inputSchema: { address: addr, days }, annotations: RO }, ({ address, days }) => route(call, `/leader/${address}/analysis${q(days)}`));
  s.registerTool("perpl_leader_alignment", { title: "Smart-money alignment", description: "Composite score and alignment of the trader's market exposure with Nansen smart-money netflow on Monad (degrades without Nansen credits).", inputSchema: { address: addr }, annotations: RO }, ({ address }) => route(call, `/leader/${address}/alignment`));
  s.registerTool("perpl_discover_leaders", { title: "Discover leader candidates", description: "Ranks Perpl's monthly PnL leaderboard into copy-trading candidates with composite scores.", inputSchema: { limit: z.number().int().min(1).max(25).optional() }, annotations: RO }, ({ limit }) => route(call, `/discover${limit ? `?limit=${limit}` : ""}`));
  s.registerTool("perpl_attest_track_record", { title: "Signed track record", description: "Canonical track record of a trader, keccak-hashed and EIP-191 signed by the Copas attester (verify with viem.verifyMessage).", inputSchema: { address: addr }, annotations: RO }, ({ address }) => route(call, `/attest/${address}`));
  s.registerTool("monad_simulate_tx", { title: "Simulate a Monad transaction", description: "Preview a transaction before signing it: balance changes and decoded Copas/Perpl events (eth_simulateV1, sender must be an EOA). Nothing is sent.", inputSchema: { from: addr, to: addr, data: z.string().regex(/^0x[0-9a-fA-F]*$/).optional(), value: z.string().regex(/^\d+$/).optional().describe("wei"), chainId: z.union([z.literal(143), z.literal(10143)]).optional().describe("143 mainnet (default) or 10143 testnet") }, annotations: RO }, (tx) => route(call, "/simulate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tx) }));
  return s;
}

/** Stateless Streamable HTTP: a fresh server + transport per request, so it runs on any serverless instance. */
export async function handleMcp(req: Request, call: Call, f?: Fetch) {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await createMcpServer(call, f).connect(transport);
  return transport.handleRequest(req);
}
