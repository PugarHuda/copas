// Read-only views shared by several commands. Every number is returned as a display string (no bigint in output).
import { type Address, erc721Abi } from "viem";
import { agentNameFromUri, BREACH_REASON, fmtAusd, type FollowParams, LEADER_STATUS, marketsFromMask, protectionRatioBps, type RegistryMarket, describeParams, symbolOf } from "./core.ts";
import { readParams, type Session } from "./host.ts";

const ZERO = "0x0000000000000000000000000000000000000000";

type Mandate = { maxDDbps: number; maxLeverageHdths: number; feeBps: number; epochLen: bigint; maxNotionalCNS: bigint; marketsMask: bigint };
type Breach = { reason: number; atBlock: bigint; pot: bigint; capTotal: bigint; claimed: bigint; swept: boolean };

const fmtUnit = (u: bigint) => (Number(u) / 1e18).toFixed(4);

export async function leaderSummary(s: Session, lb: Address, markets: RegistryMarket[]) {
  const fns = ["owner", "status", "bond", "mandate", "epoch", "unitPrice", "equity", "protection", "capacity", "capTotalNext", "peakUnitPrice", "pool", "operator"];
  const [owner, status, bond, m, epoch, [u, uValid], [eq], protection, capacity, aum, peak, pool, operator] = await s.many<
    [Address, number, bigint, Mandate, bigint, readonly [bigint, boolean], readonly [bigint, boolean], bigint, bigint, bigint, bigint, Address, Address]
  >(fns.map((fn) => ({ address: lb, name: "LeaderBook", fn })));
  const hasPool = pool !== ZERO;
  const [underwritten, agentId] = await s.many<[bigint, bigint]>([
    hasPool ? { address: pool, name: "UnderwriterPool", fn: "assets" } : { address: lb, name: "LeaderBook", fn: "feeEscrow" },
    s.dep.agentRegistry ? { address: s.dep.agentRegistry, name: "AgentLeaderRegistry", fn: "agentOf", args: [lb] } : { address: lb, name: "LeaderBook", fn: "feeEscrow" },
  ]);
  let agent: { erc8004Id: string; name: string | null; operator: Address } | null = null;
  if (s.dep.agentRegistry && agentId > 0n) {
    const uri = s.dep.identity8004
      ? await s.client.readContract({ address: s.dep.identity8004, abi: erc721Abi, functionName: "tokenURI", args: [agentId] }).catch(() => "")
      : "";
    agent = { erc8004Id: agentId.toString(), name: agentNameFromUri(uri) ?? null, operator };
  }
  const ddBps = peak > 0n && u < peak ? Number(((peak - u) * 10_000n) / peak) : 0;
  return {
    leader: lb,
    owner,
    status: LEADER_STATUS[Number(status)] ?? `#${status}`,
    agent,
    operator,
    bond: fmtAusd(bond),
    underwriterPool: hasPool ? pool : null,
    underwritten: fmtAusd(hasPool ? underwritten : 0n),
    protection: fmtAusd(protection),
    followerAum: fmtAusd(aum),
    protectionCoverage: `${(protectionRatioBps(protection, aum) / 100).toFixed(2)}% ((bond + fee escrow + underwriters) / AUM)`,
    capacityLeft: fmtAusd(capacity > aum ? capacity - aum : 0n),
    equity: fmtAusd(eq),
    epoch: epoch.toString(),
    unitPrice: uValid ? fmtUnit(u) : `${fmtUnit(u)} (mark invalid)`,
    drawdown: `${(ddBps / 100).toFixed(2)}% of max ${Number(m.maxDDbps) / 100}%`,
    mandate: {
      maxDrawdown: `${Number(m.maxDDbps) / 100}%`,
      maxLeverage: `${Number(m.maxLeverageHdths) / 100}x`,
      maxNotional: fmtAusd(m.maxNotionalCNS),
      markets: marketsFromMask(m.marketsMask, s.chainId, markets),
      epochLength: `${Number(m.epochLen) / 3600}h`,
      performanceFee: `${Number(m.feeBps) / 100}%`,
    },
    // raw values for callers that need math
    _raw: { protection, aum, maxDDbps: Number(m.maxDDbps), epoch, ddBps },
  };
}

export async function breachHistory(s: Session, lb: Address, epoch: bigint, lookback = 50n) {
  const from = epoch > lookback ? epoch - lookback + 1n : 1n;
  const epochs = [];
  for (let e = from; e <= epoch; e++) epochs.push(e);
  const all = await Promise.all(epochs.map((e) => s.read<Breach>(lb, "LeaderBook", "breachOf", [e]).then((b) => ({ e, b }))));
  return all
    .filter(({ b }) => Number(b.reason) !== 0)
    .map(({ e, b }) => ({
      epoch: e.toString(),
      reason: BREACH_REASON[Number(b.reason)] ?? `#${b.reason}`,
      atBlock: b.atBlock.toString(),
      slashedPot: fmtAusd(b.pot),
      claimed: fmtAusd(b.claimed),
      swept: b.swept,
    }));
}

type PositionInfo = { positionType: number; depositCNS: bigint; pricePNS: bigint; lotLNS: bigint; pnlCNS: bigint };

export async function vaultStatus(s: Session, vault: Address, markets: RegistryMarket[]) {
  const r = <T>(fn: string, args?: unknown[]) => s.read<T>(vault, "FollowerVault", fn, args);
  const fns = ["owner", "accountId", "leader", "following", "paused", "equity", "epochSeen", "highWaterMark", "referrer"];
  const [owner, accountId, leader, following, paused, [eq, eqValid], epochSeen, hwm, referrer] = await s.many<
    [Address, bigint, Address, boolean, boolean, readonly [bigint, boolean], bigint, bigint, Address]
  >(fns.map((fn) => ({ address: vault, name: "FollowerVault", fn })));
  const hasLeader = leader !== "0x0000000000000000000000000000000000000000";
  const params: FollowParams | null = hasLeader ? await readParams(s, vault) : null;
  const [start, flow] = await Promise.all([r<bigint>("startEquity", [epochSeen]), r<bigint>("netFlow", [epochSeen])]);
  const base = start + flow;
  const epochPnl = eq - (base > 0n ? base : 0n);

  const positions =
    accountId === 0n
      ? []
      : (
          await s.many<(readonly [PositionInfo, bigint, boolean])[]>(markets.map((m) => ({ address: s.dep.exchange, name: "PerplExchange", fn: "getPosition", args: [BigInt(m.perpId), accountId] })))
        ).map(([p, mark, ok], i) => {
              const m = markets[i];
              if (p.lotLNS === 0n) return null;
              const scale = (v: bigint, d: number) => (Number(v) / 10 ** d).toString();
              return {
                market: symbolOf(s.chainId, m.perpId),
                side: Number(p.positionType) === 0 ? "long" : "short",
                size: scale(p.lotLNS, m.lotDecimals),
                entry: scale(p.pricePNS, m.priceDecimals),
                mark: ok ? scale(mark, m.priceDecimals) : "invalid",
                margin: fmtAusd(p.depositCNS),
                pnl: `${p.pnlCNS < 0n ? "-" : ""}${fmtAusd(p.pnlCNS < 0n ? -p.pnlCNS : p.pnlCNS)}`,
              };
            })
            .filter((x) => x !== null);

  const claimable = hasLeader ? await claimableBreaches(s, vault, leader) : [];
  return {
    vault,
    owner,
    chainId: s.chainId,
    perplAccountId: accountId.toString(),
    leader: hasLeader ? leader : null,
    following,
    paused,
    equity: eqValid ? fmtAusd(eq) : `${fmtAusd(eq)} (mark invalid)`,
    epochPnl: `${epochPnl < 0n ? "-" : "+"}${fmtAusd(epochPnl < 0n ? -epochPnl : epochPnl)}`,
    highWaterMark: fmtAusd(hwm),
    limits: params ? describeParams(params, s.chainId, markets) : null,
    referrer: referrer === "0x0000000000000000000000000000000000000000" ? null : referrer,
    positions,
    claimable,
  };
}

/** Breached epochs in the claim window where this vault is eligible, unclaimed, and has a loss. */
export async function claimableBreaches(s: Session, vault: Address, lb: Address) {
  const [epoch, window] = await Promise.all([s.read<bigint>(lb, "LeaderBook", "epoch"), s.read<bigint>(s.dep.registry, "CopasRegistry", "claimWindowEpochs")]);
  const out = [];
  for (let e = epoch > window ? epoch - window : 1n; e <= epoch; e++) {
    const [b, eligible, claimed] = await Promise.all([
      s.read<Breach>(lb, "LeaderBook", "breachOf", [e]),
      s.read<boolean>(lb, "LeaderBook", "eligible", [vault, e]),
      s.read<boolean>(lb, "LeaderBook", "claimed", [e, vault]),
    ]);
    if (Number(b.reason) === 0 || b.swept || !eligible || claimed) continue;
    const [loss, cap] = await Promise.all([s.read<bigint>(vault, "FollowerVault", "lossIn", [e]), s.read<bigint>(lb, "LeaderBook", "capOf", [vault])]);
    if (loss === 0n) continue;
    const share = b.capTotal === 0n ? 0n : (b.pot * cap) / b.capTotal;
    const left = b.pot - b.claimed;
    let est = share < loss ? share : loss;
    if (est > left) est = left;
    out.push({ leader: lb, epoch: e.toString(), reason: BREACH_REASON[Number(b.reason)], loss: fmtAusd(loss), estimatedPayout: fmtAusd(est), command: `mm copas claim ${lb} ${e}` });
  }
  return out;
}
