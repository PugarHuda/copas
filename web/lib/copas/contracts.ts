import { data as abis } from "./generated/abis";
import { data as deploymentsRaw, type T as Deployments } from "./generated/deployments";
import { copasChain, monad } from "../chains";

export const copasAbi = abis;
const deployments = deploymentsRaw as unknown as Deployments;

/** Deployed Copas addresses for the active chain, or undefined until contracts are deployed. */
export const deployment = deployments[String(copasChain.id)];
export const isDeployed = !!deployment?.registry;

/** Perpl perp ids differ per chain (from the contracts team, 3 Oct). */
export const PERP_IDS: Record<number, Record<string, number>> = {
  [monad.id]: { BTC: 1, MON: 10, ETH: 20, SOL: 31, HYPE: 40, ZEC: 50, LIT: 60, VVV: 70, PUMP: 90, NEAR: 100 },
  10143: { BTC: 16, ETH: 32, SOL: 48, MON: 64 },
};
export const perpIdsForChain = () => PERP_IDS[copasChain.id];

/** Mandate tiers (SPEC A6). maxLeverage in hundredths, DD in bps. */
export const TIERS = {
  konservatif: { maxDDbps: 500, maxLeverageHdths: 300, markets: ["BTC", "ETH"] },
  moderat: { maxDDbps: 1500, maxLeverageHdths: 500, markets: ["BTC", "ETH", "SOL"] },
  agresif: { maxDDbps: 3000, maxLeverageHdths: 1000, markets: ["BTC", "ETH", "SOL", "MON"] },
} as const;
export type Tier = keyof typeof TIERS;

/** Bitmask over the registry market index order. ponytail: assumes registry.markets() order == list order below; read registry.indexOf() once deployed. */
export const marketsMask = (names: readonly string[], order: readonly string[] = ["BTC", "ETH", "SOL", "MON"]) =>
  names.reduce((m, n) => (order.indexOf(n) >= 0 ? m | (1n << BigInt(order.indexOf(n))) : m), 0n);
