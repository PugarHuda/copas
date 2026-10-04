// Pure logic: argument parsing, risk-limit checks, calldata encoding, outflow cap.
// No host SDK imports here so it is unit-testable with plain `node --test`.
import { readFileSync } from "node:fs";
import { type Abi, type Address, encodeFunctionData, erc20Abi, formatUnits, getAddress, type Hex, isAddress, parseUnits } from "viem";

export const AUSD_DECIMALS = 6;
export const CHAINS = { mainnet: 143, testnet: 10143 } as const;
export const SUPPORTED_CHAINS: readonly number[] = [CHAINS.mainnet, CHAINS.testnet];

/** Perpl perp ids per chain. The registry market list decides which ones Copas allows. */
export const PERP_IDS: Record<number, Record<string, number>> = {
  143: { BTC: 1, MON: 10, ETH: 20, SOL: 31 },
  10143: { BTC: 16, ETH: 32, SOL: 48, MON: 64 },
};

export const LEADER_STATUS = ["Active", "Unbonded", "Breached"] as const;
export const BREACH_REASON = ["None", "Drawdown", "Leverage", "Notional", "Market"] as const;

export type FollowParams = {
  ratioBps: number;
  maxLeverageHdths: number;
  maxChaseBps: number;
  priceBandBps: number;
  stopLossBps: number;
  maxNotionalCNS: bigint;
  marketsMask: bigint;
};

export type RegistryMarket = { perpId: number; priceDecimals: number; lotDecimals: number };

export class InputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// ------------------------------------------------------------------ ABIs

const pkgRoot = new URL("../../", import.meta.url);
const abiCache: Record<string, Abi> = {};
export function abi(name: "FollowerVault" | "LeaderBook" | "CopasRegistry" | "PerplExchange"): Abi {
  return (abiCache[name] ??= JSON.parse(readFileSync(new URL(`abis/${name}.json`, pkgRoot), "utf8")) as Abi);
}

// ------------------------------------------------------------------ parsing

export function parseChainId(raw: string | undefined): number {
  const v = raw === undefined || raw === "" ? CHAINS.mainnet : raw === "mainnet" ? 143 : raw === "testnet" ? 10143 : Number(raw);
  if (!SUPPORTED_CHAINS.includes(v)) throw new InputError("COPAS_UNSUPPORTED_CHAIN", `Chain '${raw}' is not supported. Use 143 (Monad) or 10143 (Monad testnet).`);
  return v;
}

export function parseAddress(raw: string | undefined, what: string): Address {
  if (!raw || !isAddress(raw)) throw new InputError("COPAS_INVALID_ADDRESS", `${what} must be a 0x address, got '${raw ?? ""}'.`);
  return getAddress(raw);
}

/** AUSD amount like "25" or "12.5" -> 6-decimal integer. Must be > 0. */
export function parseAusd(raw: string | undefined, what = "amount"): bigint {
  const s = (raw ?? "").trim().replace(/\s*AUSD$/i, "");
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new InputError("COPAS_INVALID_AMOUNT", `${what} must be a positive AUSD amount with at most 6 decimals, got '${raw ?? ""}'.`);
  const v = parseUnits(s, AUSD_DECIMALS);
  if (v <= 0n) throw new InputError("COPAS_INVALID_AMOUNT", `${what} must be greater than 0.`);
  return v;
}

export const fmtAusd = (v: bigint) => `${formatUnits(v, AUSD_DECIMALS)} AUSD`;

/** Integer basis points in [min, max]. */
export function parseBps(raw: string | undefined, what: string, min: number, max: number): number {
  const s = (raw ?? "").trim();
  if (!/^\d+$/.test(s)) throw new InputError("COPAS_INVALID_BPS", `${what} must be an integer number of basis points, got '${raw ?? ""}'.`);
  const v = Number(s);
  if (v < min || v > max) throw new InputError("COPAS_INVALID_BPS", `${what} must be between ${min} and ${max} bps, got ${v}.`);
  return v;
}

/** Copy ratio as a multiplier of the leader's size: "0.5" -> 5000 bps. Contract allows (0, 5x]. */
export function parseRatio(raw: string | undefined): number {
  const s = (raw ?? "").trim().replace(/x$/i, "");
  if (!/^\d+(\.\d{1,4})?$/.test(s)) throw new InputError("COPAS_INVALID_RATIO", `--ratio must be a multiplier like 0.25 or 1, got '${raw ?? ""}'.`);
  const bps = Math.round(Number(s) * 10_000);
  if (bps <= 0 || bps > 50_000) throw new InputError("COPAS_INVALID_RATIO", `--ratio must be > 0 and <= 5 (got ${s}).`);
  return bps;
}

/** Leverage like "3" or "2.5x" -> hundredths (300). Contract minimum is 1x. */
export function parseLeverage(raw: string | undefined): number {
  const s = (raw ?? "").trim().replace(/x$/i, "");
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new InputError("COPAS_INVALID_LEVERAGE", `--max-leverage must be like 2 or 2.5x, got '${raw ?? ""}'.`);
  const h = Math.round(Number(s) * 100);
  if (h < 100 || h > 5_000) throw new InputError("COPAS_INVALID_LEVERAGE", `--max-leverage must be between 1x and 50x (got ${s}x).`);
  return h;
}

/** "BTC,ETH" -> bitmask over the registry's market list (bit i = registry market i). */
export function parseMarkets(raw: string | undefined, chainId: number, registryMarkets: readonly RegistryMarket[]): { mask: bigint; symbols: string[] } {
  const symbols = (raw ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (symbols.length === 0) throw new InputError("COPAS_INVALID_MARKETS", "--markets must list at least one market, e.g. BTC,ETH.");
  let mask = 0n;
  for (const sym of symbols) {
    const perpId = PERP_IDS[chainId]?.[sym];
    if (perpId === undefined) throw new InputError("COPAS_INVALID_MARKETS", `Unknown market '${sym}' on chain ${chainId}. Known: ${Object.keys(PERP_IDS[chainId] ?? {}).join(", ")}.`);
    const idx = registryMarkets.findIndex((m) => m.perpId === perpId);
    if (idx < 0) throw new InputError("COPAS_MARKET_NOT_LISTED", `Market ${sym} (perp ${perpId}) is not in the Copas registry on chain ${chainId}.`);
    mask |= 1n << BigInt(idx);
  }
  return { mask, symbols };
}

export function marketsFromMask(mask: bigint, chainId: number, registryMarkets: readonly RegistryMarket[]): string[] {
  return registryMarkets.flatMap((m, i) => ((mask >> BigInt(i)) & 1n ? [symbolOf(chainId, m.perpId)] : []));
}

export function symbolOf(chainId: number, perpId: number): string {
  return Object.entries(PERP_IDS[chainId] ?? {}).find(([, id]) => id === perpId)?.[0] ?? `perp#${perpId}`;
}

/** Resolves a market argument ("BTC" or a numeric perp id) to a perp id. */
export function parsePerpId(raw: string | undefined, chainId: number): number {
  const s = (raw ?? "").trim().toUpperCase();
  if (/^\d+$/.test(s)) return Number(s);
  const id = PERP_IDS[chainId]?.[s];
  if (id === undefined) throw new InputError("COPAS_INVALID_MARKETS", `Unknown market '${raw ?? ""}' on chain ${chainId}.`);
  return id;
}

// ------------------------------------------------------------------ follow limits

export type FollowFlags = {
  ratio?: string;
  maxNotional?: string;
  maxLeverage?: string;
  chaseBps?: string;
  bandBps?: string;
  stopLossBps?: string;
  markets?: string;
};

const LIMIT_FLAGS: [keyof FollowFlags, string][] = [
  ["ratio", "--ratio"],
  ["maxNotional", "--max-notional"],
  ["maxLeverage", "--max-leverage"],
  ["chaseBps", "--chase-bps"],
  ["bandBps", "--band-bps"],
  ["stopLossBps", "--stop-loss-bps"],
  ["markets", "--markets"],
];

/** Every risk limit is mandatory. There are deliberately no defaults: refusing is safer than guessing. */
export function buildFollowParams(f: FollowFlags, chainId: number, registryMarkets: readonly RegistryMarket[]): FollowParams {
  const missing = LIMIT_FLAGS.filter(([k]) => !f[k] || String(f[k]).trim() === "").map(([, n]) => n);
  if (missing.length) throw new InputError("COPAS_LIMITS_REQUIRED", `Refusing to follow without explicit risk limits. Missing: ${missing.join(", ")}.`);
  return {
    ratioBps: parseRatio(f.ratio),
    maxNotionalCNS: parseAusd(f.maxNotional, "--max-notional"),
    maxLeverageHdths: parseLeverage(f.maxLeverage),
    maxChaseBps: parseBps(f.chaseBps, "--chase-bps", 0, 2_000),
    priceBandBps: parseBps(f.bandBps, "--band-bps", 1, 500),
    stopLossBps: parseBps(f.stopLossBps, "--stop-loss-bps", 1, 10_000),
    marketsMask: parseMarkets(f.markets, chainId, registryMarkets).mask,
  };
}

/** Applies only the flags given, then checks that nothing got riskier (the contract enforces the same). */
export function buildTightenParams(current: FollowParams, f: FollowFlags, chainId: number, registryMarkets: readonly RegistryMarket[]): FollowParams {
  const next: FollowParams = {
    ratioBps: f.ratio ? parseRatio(f.ratio) : current.ratioBps,
    maxNotionalCNS: f.maxNotional ? parseAusd(f.maxNotional, "--max-notional") : current.maxNotionalCNS,
    maxLeverageHdths: f.maxLeverage ? parseLeverage(f.maxLeverage) : current.maxLeverageHdths,
    maxChaseBps: f.chaseBps ? parseBps(f.chaseBps, "--chase-bps", 0, 2_000) : current.maxChaseBps,
    priceBandBps: f.bandBps ? parseBps(f.bandBps, "--band-bps", 1, 500) : current.priceBandBps,
    stopLossBps: f.stopLossBps ? parseBps(f.stopLossBps, "--stop-loss-bps", 1, 10_000) : current.stopLossBps,
    marketsMask: f.markets ? parseMarkets(f.markets, chainId, registryMarkets).mask : current.marketsMask,
  };
  const raised: string[] = [];
  if (next.ratioBps > current.ratioBps) raised.push("--ratio");
  if (next.maxNotionalCNS > current.maxNotionalCNS) raised.push("--max-notional");
  if (next.maxLeverageHdths > current.maxLeverageHdths) raised.push("--max-leverage");
  if (next.maxChaseBps > current.maxChaseBps) raised.push("--chase-bps");
  if (next.priceBandBps > current.priceBandBps) raised.push("--band-bps");
  if ((next.marketsMask & ~current.marketsMask) !== 0n) raised.push("--markets");
  // stopLossBps is not checked by the contract; a looser stop-loss is still riskier, so refuse it here too.
  if (current.stopLossBps !== 0 && (next.stopLossBps === 0 || next.stopLossBps > current.stopLossBps)) raised.push("--stop-loss-bps");
  if (raised.length) throw new InputError("COPAS_NOT_TIGHTER", `tighten can only lower risk. These would raise it: ${raised.join(", ")}. To raise limits, unfollow and follow again with explicit user confirmation.`);
  return next;
}

export function describeParams(p: FollowParams, chainId: number, registryMarkets: readonly RegistryMarket[]) {
  return {
    ratio: `${p.ratioBps / 10_000}x leader size`,
    maxNotional: fmtAusd(p.maxNotionalCNS),
    maxLeverage: `${p.maxLeverageHdths / 100}x`,
    chaseBps: p.maxChaseBps,
    bandBps: p.priceBandBps,
    stopLossBps: p.stopLossBps,
    markets: marketsFromMask(p.marketsMask, chainId, registryMarkets),
  };
}

/** "max protection = bond / AUM": share of follower exposure the leader's slashable stake can cover. */
export function protectionRatioBps(protection: bigint, aumAfter: bigint): number {
  if (aumAfter === 0n) return 10_000;
  const r = (protection * 10_000n) / aumAfter;
  return Number(r > 10_000n ? 10_000n : r);
}

export function riskDisclosure(o: { protection: bigint; aumAfter: bigint; maxNotional: bigint; leaderMaxDDbps: number }): string {
  const pct = protectionRatioBps(o.protection, o.aumAfter) / 100;
  return [
    "RISK DISCLOSURE",
    `- Max protection = bond / AUM = ${fmtAusd(o.protection)} / ${fmtAusd(o.aumAfter)} = ${pct.toFixed(2)}% of losses, and only if the leader breaches its mandate.`,
    `- Losses within the leader's declared drawdown (${o.leaderMaxDDbps / 100}%) are NOT compensated.`,
    `- Your exposure is capped at ${fmtAusd(o.maxNotional)} notional; perps can still lose more than expected on gaps or intra-block moves.`,
    "- Contracts are unaudited. Mainnet deposits are capped per vault.",
  ].join("\n");
}

// ------------------------------------------------------------------ calldata

export type Tx = { to: Address; data: Hex };

const asTuple = (p: FollowParams) => ({ ...p });

export const encode = {
  createVault: (registry: Address): Tx => ({ to: registry, data: encodeFunctionData({ abi: abi("CopasRegistry"), functionName: "createVault" }) }),
  approve: (token: Address, spender: Address, amount: bigint): Tx => ({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }) }),
  deposit: (vault: Address, amount: bigint): Tx => ({ to: vault, data: encodeFunctionData({ abi: abi("FollowerVault"), functionName: "deposit", args: [amount] }) }),
  withdraw: (vault: Address, amount: bigint): Tx => ({ to: vault, data: encodeFunctionData({ abi: abi("FollowerVault"), functionName: "withdraw", args: [amount] }) }),
  follow: (vault: Address, leader: Address, p: FollowParams): Tx => ({ to: vault, data: encodeFunctionData({ abi: abi("FollowerVault"), functionName: "follow", args: [leader, asTuple(p)] }) }),
  tighten: (vault: Address, p: FollowParams): Tx => ({ to: vault, data: encodeFunctionData({ abi: abi("FollowerVault"), functionName: "tighten", args: [asTuple(p)] }) }),
  unfollow: (vault: Address): Tx => ({ to: vault, data: encodeFunctionData({ abi: abi("FollowerVault"), functionName: "unfollow" }) }),
  sync: (vault: Address, perpId: number): Tx => ({ to: vault, data: encodeFunctionData({ abi: abi("FollowerVault"), functionName: "sync", args: [BigInt(perpId)] }) }),
  claim: (vault: Address, leader: Address, epoch: bigint): Tx => ({ to: vault, data: encodeFunctionData({ abi: abi("FollowerVault"), functionName: "claim", args: [leader, epoch] }) }),
  setReferrer: (vault: Address, ref: Address): Tx => ({ to: vault, data: encodeFunctionData({ abi: abi("FollowerVault"), functionName: "setReferrer", args: [ref] }) }),
};

// ------------------------------------------------------------------ outflow cap

export type WithdrawEntry = { ts: number; amount: string; chainId: number; vault: string };
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Rolling 24h plugin-level outflow cap. Returns the amount already used in the window. */
export function checkWithdrawCap(entries: readonly WithdrawEntry[], amount: bigint, cap: bigint, now: number): bigint {
  const used = entries.filter((e) => now - e.ts < DAY_MS).reduce((s, e) => s + BigInt(e.amount), 0n);
  if (used + amount > cap) {
    throw new InputError(
      "COPAS_OUTFLOW_CAP",
      `Withdrawal of ${fmtAusd(amount)} exceeds the plugin outflow cap: ${fmtAusd(used)} already withdrawn in the last 24h, cap ${fmtAusd(cap)}/day.`,
    );
  }
  return used;
}
