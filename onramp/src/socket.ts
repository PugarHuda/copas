// Socket / Bungee V3 deposit address: USDT on BSC -> AUSD on Monad (verified live; fixtures test/fixtures/socket-*).
//   GET  /v3/swap/quote?userOps=deposit&...           routes[], each with quoteId + activationRequired
//   POST /v3/swap/quote/{quoteId}/activate            only for preview routes (activationRequired: true)
//   GET  /v3/swap/status?quoteId=                     PENDING | IN_PROGRESS | COMPLETED | FAILED | EXPIRED | REFUNDED
import type { Address } from 'viem';
import { MONAD } from './config.js';
import { fetchJson, type FetchFn } from './http.js';

export const SOCKET_URL = 'https://public-backend.socket.tech/v3/swap';
export const BSC_USDT = '0x55d398326f99059ff775485246999027b3197955' as Address;

type Token = { chainId: number; address: string; symbol: string; decimals: number };
export type SocketRoute = {
  quoteId: string;
  expiresAt: number;
  activationRequired?: boolean;
  estimatedTime: number;
  output: { token: Token; amount: string; minAmountOut: string; valueInUsd?: number };
  routeDetails?: { bridgeDetails?: { protocol?: { name: string; displayName?: string } } | null } | null;
  deposit?: { chainId: number; token: Token; amount: string; depositAddress: string; memo: string | null } | null;
  txData?: { kind: string; object: { chainId: number; to: string; data: string; value: string } } | null;
};
type Envelope<T> = { success: boolean; statusCode: number; result: T; message?: string | null };

export type SocketOpts = { fetch?: FetchFn };
const SLOW = 60_000; // quotes fan out to many bridges and regularly take >20 s

export async function depositAddress(
  a: { receiver: Address; refundAddress: Address; amount: string; originChainId?: number; inputToken?: string },
  o: SocketOpts = {},
) {
  const qs = new URLSearchParams({
    userOps: 'deposit',
    originChainId: String(a.originChainId ?? 56),
    destinationChainId: String(MONAD.chainId),
    inputToken: a.inputToken ?? BSC_USDT,
    outputToken: MONAD.AUSD,
    inputAmount: a.amount,
    receiverAddress: a.receiver,
    userAddress: a.receiver,
    refundAddress: a.refundAddress, // required for every deposit route
  });
  const q = await fetchJson<Envelope<{ routes: SocketRoute[] }>>(`${SOCKET_URL}/quote?${qs}`, {}, { ...o, timeoutMs: SLOW });
  const routes = q.result.routes ?? [];
  // Routes come best-first. Prefer one that is already active (has a deposit address), else activate the best.
  let route = routes.find((r) => !r.activationRequired && r.deposit?.depositAddress) ?? routes[0];
  if (!route) throw new Error('Socket returned no deposit routes');
  if (!route.deposit?.depositAddress) {
    const act = await fetchJson<Envelope<SocketRoute | { routes: SocketRoute[] }>>(
      `${SOCKET_URL}/quote/${encodeURIComponent(route.quoteId)}/activate`,
      { method: 'POST' },
      { ...o, timeoutMs: SLOW },
    );
    route = 'routes' in act.result ? act.result.routes[0]! : act.result;
    if (!route?.deposit?.depositAddress) throw new Error('Socket activation returned no deposit address');
  }
  const dep = route.deposit!;
  return {
    quoteId: route.quoteId,
    depositAddress: dep.depositAddress,
    memo: dep.memo,
    chainId: dep.chainId,
    token: dep.token,
    /** The user must send exactly this amount (atomic units of `token`). */
    amount: dep.amount,
    output: route.output.amount,
    minOutput: route.output.minAmountOut,
    outputToken: route.output.token,
    estimatedTimeSec: route.estimatedTime,
    expiresAt: route.expiresAt,
    bridge: route.routeDetails?.bridgeDetails?.protocol?.name ?? null,
    /** Ready-made ERC-20 transfer for wallets that are connected on the origin chain. */
    txData: route.txData?.object ?? null,
  };
}

export type SocketStatus = {
  quoteId: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'EXPIRED' | 'REFUNDED';
  origin: { chainId: number; status: string; txHash: string | null };
  destination: { chainId: number; status: string; txHash: string | null; output: { amount: string }[] };
  refund?: { refundAddress: string; txHash?: string | null } | null;
};

export async function status(quoteId: string, o: SocketOpts = {}) {
  const r = await fetchJson<Envelope<SocketStatus>>(`${SOCKET_URL}/status?quoteId=${encodeURIComponent(quoteId)}`, {}, o);
  const s = r.result;
  return {
    quoteId: s.quoteId,
    status: s.status,
    terminal: ['COMPLETED', 'FAILED', 'EXPIRED', 'REFUNDED'].includes(s.status),
    originTx: s.origin?.txHash ?? null,
    destinationTx: s.destination?.txHash ?? null,
    refund: s.refund ?? null,
    raw: s,
  };
}
