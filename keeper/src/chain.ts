import { createPublicClient, fallback, http, webSocket, type PublicClient } from 'viem';
import { monad, monadTestnet } from 'viem/chains';
import { cfg } from './config.js';

export const chain = cfg.chainId === 143 ? monad : monadTestnet;

// The official testnet RPC rate-limits shared CI IPs (failed syncs); fail over to other public endpoints.
const TESTNET_RPCS = ['https://rpc.ankr.com/monad_testnet', 'https://rpc-testnet.monadinfra.com', 'https://10143.rpc.thirdweb.com'];
export const rpcTransport = () =>
  cfg.chainId === 143
    ? http(cfg.rpcUrl, { retryCount: 3 })
    : fallback([cfg.rpcUrl, ...TESTNET_RPCS].map((u) => http(u, { retryCount: 1, timeout: 15_000 })));

// multicall batching folds the many view calls per tick into a few eth_calls (multicall3 is deployed on both chains)
export const client: PublicClient = createPublicClient({
  chain,
  transport: cfg.wsUrl ? webSocket(cfg.wsUrl, { reconnect: true }) : rpcTransport(),
  batch: { multicall: true },
}) as PublicClient;
