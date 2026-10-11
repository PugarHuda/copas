// Aurora Intents Deposits / 1Click Swap: any-chain -> USDC on Monad, delivered to the user's Mera EOA.
// Same request/response shape on both hosts (verified live 3 Oct 2026, fixtures in test/fixtures/oneclick-*):
//   no key:   https://1click.chaindefuser.com/v0/{quote,status}           (+25 bps protocol fee)
//   with key: https://intents-api.aurora.dev/api/{quote,status}/{apiKey}  (key fees from studio.aurora.dev)
import { ASSETS, SOURCES, type SourceToken } from '../config.js';
import { fetchJson, type FetchFn } from '../http.js';

export const ONECLICK_URL = 'https://1click.chaindefuser.com/v0';
export const AURORA_API_URL = 'https://intents-api.aurora.dev/api';

export type AuroraOpts = { apiKey?: string; fetch?: FetchFn };

export type QuoteInput = {
  /** NEAR Intents asset id of the source token (see SOURCES). */
  originAsset: string;
  /** Atomic units of the source token. */
  amount: string;
  /** Address on the ORIGIN chain that receives refunds. */
  refundTo: string;
  /** Mera EOA on Monad that receives USDC. */
  recipient: string;
  slippageBps?: number;
  /** How long the deposit address stays valid. Default 2 h. */
  validForMs?: number;
  dry?: boolean;
};

export type QuoteResponse = {
  quote: {
    amountIn: string;
    amountInFormatted: string;
    amountInUsd: string;
    minAmountIn: string;
    amountOut: string;
    amountOutFormatted: string;
    amountOutUsd: string;
    minAmountOut: string;
    timeEstimate: number;
    refundFee?: string;
    withdrawFee?: string;
    deadline?: string;
    timeWhenInactive?: string;
    depositAddress?: string;
    depositMemo?: string;
  };
  quoteRequest: Record<string, unknown>;
  signature: string;
  timestamp: string;
  correlationId?: string;
};

export type SwapStatus =
  | 'KNOWN_DEPOSIT_TX'
  | 'PENDING_DEPOSIT'
  | 'INCOMPLETE_DEPOSIT'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'REFUNDED'
  | 'FAILED';

export type StatusResponse = {
  status: SwapStatus;
  updatedAt: string;
  correlationId?: string;
  swapDetails: {
    depositedAmount: string | null;
    depositedAmountFormatted: string | null;
    amountOut: string | null;
    amountOutFormatted: string | null;
    refundedAmount: string | null;
    refundedAmountFormatted: string | null;
    refundReason: string | null;
    originChainTxHashes: { hash: string; explorerUrl?: string }[];
    destinationChainTxHashes: { hash: string; explorerUrl?: string }[];
  };
  quoteResponse?: QuoteResponse;
};

export function findSource(id: string): SourceToken | undefined {
  // "base:USDC" or a raw asset id
  const [chain, symbol] = id.split(':');
  return SOURCES.find((s) => s.assetId === id || (s.chain === chain && s.symbol.toUpperCase() === symbol?.toUpperCase()));
}

const quoteUrl = (k?: string) => (k ? `${AURORA_API_URL}/quote/${encodeURIComponent(k)}` : `${ONECLICK_URL}/quote`);
const statusUrl = (k?: string) => (k ? `${AURORA_API_URL}/status/${encodeURIComponent(k)}` : `${ONECLICK_URL}/status`);

export function quoteBody(i: QuoteInput, now = Date.now()) {
  return {
    dry: i.dry ?? true,
    swapType: 'EXACT_INPUT',
    depositType: 'ORIGIN_CHAIN',
    depositMode: 'SIMPLE',
    amount: i.amount,
    originAsset: i.originAsset,
    // Monad only supports MON / USDC / USDT0 on Intents; AUSD comes from the Kuru Flow second step.
    destinationAsset: ASSETS.monad.USDC,
    slippageTolerance: i.slippageBps ?? 100,
    refundTo: i.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: i.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: new Date(now + (i.validForMs ?? 2 * 3600_000)).toISOString(),
    quoteWaitingTimeMs: 3000,
  };
}

export function quote(i: QuoteInput, o: AuroraOpts = {}): Promise<QuoteResponse> {
  return fetchJson<QuoteResponse>(quoteUrl(o.apiKey), { method: 'POST', body: JSON.stringify(quoteBody(i)) }, o);
}

/** Real (non-dry) quote: returns a one-off deposit address valid until `deadline`. */
export async function depositAddress(i: Omit<QuoteInput, 'dry'>, o: AuroraOpts = {}) {
  const r = await quote({ ...i, dry: false }, o);
  if (!r.quote.depositAddress) throw new Error('1Click returned no depositAddress');
  return {
    depositAddress: r.quote.depositAddress,
    memo: r.quote.depositMemo ?? null,
    amountIn: r.quote.amountIn,
    amountInFormatted: r.quote.amountInFormatted,
    amountOut: r.quote.amountOut,
    minAmountOut: r.quote.minAmountOut,
    deadline: r.quote.deadline ?? null,
    timeEstimateSec: r.quote.timeEstimate,
    refundFee: r.quote.refundFee ?? null,
    correlationId: r.correlationId ?? null,
  };
}

export function status(depositAddr: string, o: AuroraOpts = {}): Promise<StatusResponse> {
  return fetchJson<StatusResponse>(`${statusUrl(o.apiKey)}?depositAddress=${encodeURIComponent(depositAddr)}`, {}, o);
}

export type Phase = 'awaiting_deposit' | 'processing' | 'delivered' | 'refunded' | 'incomplete_deposit' | 'failed';

/** Maps 1Click status to what the UI shows, including refund handling. */
export function summarize(s: StatusResponse) {
  const d = s.swapDetails;
  const phase: Phase = (
    {
      PENDING_DEPOSIT: 'awaiting_deposit',
      KNOWN_DEPOSIT_TX: 'processing',
      PROCESSING: 'processing',
      SUCCESS: 'delivered',
      REFUNDED: 'refunded',
      // Sent less than minAmountIn: user can top up before the deadline, otherwise it is refunded.
      INCOMPLETE_DEPOSIT: 'incomplete_deposit',
      FAILED: 'failed',
    } as const
  )[s.status];
  return {
    status: s.status,
    phase,
    terminal: phase === 'delivered' || phase === 'refunded' || phase === 'failed',
    /** True once USDC sits in the Mera EOA: the UI should now run the Kuru swap + vault deposit. */
    readyForDeposit: phase === 'delivered',
    deposited: d.depositedAmountFormatted,
    received: d.amountOutFormatted,
    receivedAtomic: d.amountOut,
    refunded: d.refundedAmount && d.refundedAmount !== '0' ? d.refundedAmountFormatted : null,
    refundReason: d.refundReason,
    originTx: d.originChainTxHashes.map((t) => t.hash),
    destinationTx: d.destinationChainTxHashes.map((t) => t.hash),
    updatedAt: s.updatedAt,
  };
}

/**
 * Persistent (reusable) deposit address per user. Needs an Aurora-approved org key (others get 403),
 * so the server falls back to per-quote addresses when it fails. All EVM chains share one address.
 */
export function persistentDepositAddress(
  i: { recipient: string; sender: string; depositChain: string },
  o: AuroraOpts & { apiKey: string },
) {
  return fetchJson<{ depositAddress: string; alreadyExists: boolean; memo?: string }>(
    `${AURORA_API_URL}/persistent-deposit-address/${encodeURIComponent(o.apiKey)}`,
    {
      method: 'POST',
      body: JSON.stringify({ ...i, destinationChain: 'monad', destinationAsset: ASSETS.monad.USDC }),
    },
    o,
  );
}

export function persistentDepositStatus(address: string, o: AuroraOpts & { apiKey: string }) {
  return fetchJson<unknown>(
    `${AURORA_API_URL}/persistent-deposit-status/${encodeURIComponent(o.apiKey)}?address=${encodeURIComponent(address)}`,
    {},
    o,
  );
}
