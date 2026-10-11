// Aurora Intents Connect (alpha) deposit-and-follow recipe. Behind AURORA_CONNECT=1 because the
// Connect API key (x-api-key on the two create calls) needs alpha access; everything else is public.
//
// Bridge-in flow: source chain -> USDC lands at the user's intermediary on Monad -> steps:
//   1. USDC.approve(KuruFlowEntrypoint, {MIN_AMOUNT_OUT})
//   2. KuruFlow.executeSwap(USDC -> AUSD)            amountIn = {MIN_AMOUNT_OUT}, minOut fixed from a pre-quote
//   3. AUSD.approve(vault, depositAmount)
//   4. FollowerVault.deposit(depositAmount)          anyone may fund an owner's vault
// No quote.recipient (the intermediary is the recipient). Funds only ever reach the user's own vault.
import type { Address } from 'viem';
import { ASSETS, MONAD } from '../config.js';
import { fetchJson, type FetchFn } from '../http.js';
import { KURU_EXECUTE_SWAP_SIG, decodeKuruSwap, type KuruFlow } from '../kuru/flow.js';

// Structural copies of the SDK's Recipe/Step types (v7.24.2 src/types/recipe.ts, execution.ts): its d.ts uses
// extensionless re-exports that NodeNext cannot resolve. The object below is passed to runner.run() as-is.
type StepParameter = string | StepParameter[];
export type Step = { to: string; functionSignature: string; parameters: StepParameter[]; value: string; metadata?: Record<string, unknown> };
export type Recipe<P> = {
  id: string;
  intent: string;
  title: string;
  flow: 'bridge-in' | 'steps-only';
  type: 'evm';
  destination: { chain: string; assetId: string; tokenAddress?: string };
  buildSteps: (ctx: { intermediary: string; userAddress: string; amount: string }, params: P) => Step[];
};

export const CONNECT_URL = 'https://intents-connect-alpha-api.aurora.dev';

export type DepositAndFollowParams = {
  vault: Address;
  /** Decoded Kuru swap, quoted for the intermediary at a conservative USDC amount. */
  swap: ReturnType<typeof decodeKuruSwap>;
  /** AUSD atomic amount deposited (= the swap's minOut). */
  depositAmount: string;
};

export const depositAndFollowRecipe: Recipe<DepositAndFollowParams> = {
  id: 'copas-deposit-and-follow',
  intent: 'copas_deposit_and_follow',
  title: 'Fund Copas vault',
  flow: 'bridge-in',
  type: 'evm',
  destination: { chain: 'monad', assetId: ASSETS.monad.USDC, tokenAddress: MONAD.USDC },
  buildSteps: ({ amount }, { vault, swap, depositAmount }): Step[] => [
    // Calls destination.tokenAddress, which satisfies the "fee is charged in the destination token" rule.
    {
      to: MONAD.USDC,
      functionSignature: 'approve(address,uint256)',
      parameters: [MONAD.KURU_FLOW_ENTRYPOINT, amount],
      value: '0',
    },
    {
      to: MONAD.KURU_FLOW_ENTRYPOINT,
      functionSignature: KURU_EXECUTE_SWAP_SIG,
      // The route is share-based (0xffff = 100%), so swapping the real amount instead of the quoted one is fine;
      // minOut from the smaller pre-quote still protects the user.
      parameters: [[swap.tokenOut, swap.minOut, swap.tokenIn, amount], [...swap.opts], swap.route],
      value: '0',
    },
    { to: MONAD.AUSD, functionSignature: 'approve(address,uint256)', parameters: [vault, depositAmount], value: '0' },
    { to: vault, functionSignature: 'deposit(uint256)', parameters: [depositAmount], value: '0' },
  ],
};

export function getIntermediary(wallet: string, o: { fetch?: FetchFn } = {}) {
  return fetchJson<{ result: { evm: Address; solana?: string; originAccount: string; originType: string } }>(
    `${CONNECT_URL}/api/v1/executions/${encodeURIComponent(wallet)}/intermediary`,
    {},
    o,
  ).then((r) => r.result);
}

/**
 * Builds recipe params server-side (the Kuru JWT + rate limiter live here).
 * `expectedUsdc` = the bridge quote's minAmountOut; we quote the swap at expectedUsdc * (1 - reserve)
 * to leave room for the Connect network fee (~0.13 USDC observed). The leftover AUSD stays in the
 * user's intermediary and can be swept with a steps-only execution.
 * ponytail: fixed reserve; switch to the SDK's threeRound fee strategy if the fee varies a lot.
 */
export async function planDepositAndFollow(
  kuru: KuruFlow,
  a: { intermediary: Address; vault: Address; expectedUsdc: string; reserveBps?: number },
): Promise<DepositAndFollowParams> {
  const usdc = (BigInt(a.expectedUsdc) * BigInt(10_000 - (a.reserveBps ?? 300))) / 10_000n;
  const q = await kuru.quote({ userAddress: a.intermediary, tokenIn: MONAD.USDC, amount: usdc.toString() });
  const swap = decodeKuruSwap(q.transaction.calldata);
  return { vault: a.vault, swap, depositAmount: swap.minOut };
}

/** Paths the browser SDK may send through our key proxy (the two 🔑 create calls only). */
export const CONNECT_PROXY_PATH = /^\/api\/v1\/executions\/[^/]+(\/steps)?$/;
