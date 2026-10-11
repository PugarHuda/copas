// Kuru Flow aggregator on Monad mainnet (verified live; fixtures test/fixtures/kuru-*).
//   POST https://ws.kuru.io/api/generate-token {user_address} -> {token, expires_at, rate_limit:{rps:1,burst:1}}
//   POST https://ws.kuru.io/api/quote (Bearer JWT) -> {status:'success', output, minOut, transaction:{calldata,value,to}}
import { decodeFunctionData, encodeFunctionData, erc20Abi, parseAbi, type Address, type Hex } from 'viem';
import { MONAD } from '../config.js';
import { fetchJson, limiter, type FetchFn } from '../http.js';

export const KURU_FLOW_URL = 'https://ws.kuru.io/api';

/**
 * Entrypoint selector 0xce1e7030 is not in 4byte/openchain and the contract is unverified;
 * this signature was recovered by matching the selector and decodes/re-encodes the live calldata exactly
 * (see test). Needed to express the swap as an Intents Connect step (functionSignature + parameters).
 */
export const KURU_EXECUTE_SWAP_SIG =
  'executeSwap((address,uint256,address,uint256),(address,uint256,address,uint256,bool),bytes)';
const flowAbi = parseAbi([`function ${KURU_EXECUTE_SWAP_SIG}`]);
const vaultAbi = parseAbi(['function deposit(uint256 amount)']);

export type KuruQuote = {
  type: string;
  status: string;
  output: string;
  minOut: string;
  transaction: { calldata: string; value: string; to: Address };
  gasPrices?: Record<string, string>;
};

export type Tx = { to: Address; data: Hex; value: string; label: string };

export class KuruFlow {
  private tokens = new Map<string, { token: string; exp: number }>();
  // ponytail: one global 1 rps queue for all users; per-JWT queues if quote volume ever matters.
  private run = limiter(1100);

  constructor(
    private o: { fetch?: FetchFn; referrer?: Address; referrerFeeBps?: number; intervalMs?: number } = {},
  ) {
    if (o.intervalMs !== undefined) this.run = limiter(o.intervalMs);
  }

  private async jwt(user: string): Promise<string> {
    const key = user.toLowerCase();
    const hit = this.tokens.get(key);
    if (hit && hit.exp - 60 > Date.now() / 1000) return hit.token;
    const r = await this.run(() =>
      fetchJson<{ token: string; expires_at: number }>(
        `${KURU_FLOW_URL}/generate-token`,
        { method: 'POST', body: JSON.stringify({ user_address: user }) },
        this.o,
      ),
    );
    this.tokens.set(key, { token: r.token, exp: r.expires_at });
    return r.token;
  }

  async quote(q: { userAddress: Address; tokenIn: Address; tokenOut?: Address; amount: string }): Promise<KuruQuote> {
    const token = await this.jwt(q.userAddress);
    const body = {
      userAddress: q.userAddress,
      tokenIn: q.tokenIn,
      tokenOut: q.tokenOut ?? MONAD.AUSD,
      amount: q.amount,
      autoSlippage: true,
      ...(this.o.referrer ? { referrerAddress: this.o.referrer, referrerFeeBps: this.o.referrerFeeBps ?? 0 } : {}),
    };
    const r = await this.run(() =>
      fetchJson<KuruQuote>(
        `${KURU_FLOW_URL}/quote`,
        { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) },
        this.o,
      ),
    );
    if (r.status !== 'success') throw new Error(`Kuru quote failed: ${JSON.stringify(r).slice(0, 300)}`);
    return r;
  }
}

/**
 * Txs the user's wallet sends (batched by Mera) to turn tokenIn into AUSD and, optionally,
 * fund their FollowerVault. Deposits `minOut`; any extra AUSD from positive slippage stays in the wallet.
 */
export function swapTxs(q: KuruQuote, tokenIn: Address, amount: string, vault?: Address): Tx[] {
  const swap = q.transaction;
  const txs: Tx[] = [];
  if (tokenIn.toLowerCase() !== MONAD.MON) {
    txs.push({
      to: tokenIn,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [swap.to, BigInt(amount)] }),
      value: '0',
      label: 'approve Kuru Flow',
    });
  }
  txs.push({ to: swap.to, data: withHex(swap.calldata), value: swap.value, label: 'swap to AUSD (Kuru Flow)' });
  if (vault) {
    const amt = BigInt(q.minOut);
    txs.push(
      {
        to: MONAD.AUSD,
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [vault, amt] }),
        value: '0',
        label: 'approve vault',
      },
      {
        to: vault,
        data: encodeFunctionData({ abi: vaultAbi, functionName: 'deposit', args: [amt] }),
        value: '0',
        label: 'FollowerVault.deposit',
      },
    );
  }
  return txs;
}

export const withHex = (s: string): Hex => (s.startsWith('0x') ? s : `0x${s}`) as Hex;

/** Decodes Kuru Flow calldata into Intents Connect step parameters (all values as strings). */
export function decodeKuruSwap(calldata: string) {
  const { args } = decodeFunctionData({ abi: flowAbi, data: withHex(calldata) });
  const [order, opts, route] = args as unknown as [
    readonly [Address, bigint, Address, bigint],
    readonly [Address, bigint, Address, bigint, boolean],
    Hex,
  ];
  return {
    tokenOut: order[0],
    minOut: order[1].toString(),
    tokenIn: order[2],
    amountIn: order[3].toString(),
    opts: opts.map(String) as [string, string, string, string, string],
    route,
  };
}

export function encodeKuruSwap(d: ReturnType<typeof decodeKuruSwap>): Hex {
  const o = d.opts;
  return encodeFunctionData({
    abi: flowAbi,
    functionName: 'executeSwap',
    args: [
      [d.tokenOut, BigInt(d.minOut), d.tokenIn, BigInt(d.amountIn)],
      [o[0] as Address, BigInt(o[1]), o[2] as Address, BigInt(o[3]), o[4] === 'true'],
      d.route,
    ],
  });
}
