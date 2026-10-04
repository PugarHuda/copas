import { createPublicClient, http, webSocket, type PublicClient } from 'viem';
import { monad, monadTestnet } from 'viem/chains';
import { cfg } from './config.js';

export const chain = cfg.chainId === 143 ? monad : monadTestnet;

// multicall batching folds the many view calls per tick into a few eth_calls (multicall3 is deployed on both chains)
export const client: PublicClient = createPublicClient({
  chain,
  transport: cfg.wsUrl ? webSocket(cfg.wsUrl, { reconnect: true }) : http(cfg.rpcUrl, { retryCount: 3 }),
  batch: { multicall: true },
}) as PublicClient;
