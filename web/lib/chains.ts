import { defineChain, fallback, http, type Chain } from "viem";

const multicall3 = { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } as const;

export const monad = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_MONAD_RPC_URL || "https://rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "MonadScan", url: "https://monadscan.com" } },
  contracts: { multicall3 },
});

export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  // The official RPC rate-limits shared Vercel IPs; reads fall through these in order (rpcTransport).
  rpcUrls: {
    default: {
      http: [
        process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz",
        "https://rpc.ankr.com/monad_testnet",
        "https://rpc-testnet.monadinfra.com",
        "https://10143.rpc.thirdweb.com",
      ],
    },
  },
  blockExplorers: { default: { name: "MonadScan", url: "https://testnet.monadscan.com" } },
  contracts: { multicall3 },
  testnet: true,
});

/** Chain the Copas contracts live on. Analytics always read Perpl mainnet. */
export const copasChain = process.env.NEXT_PUBLIC_COPAS_CHAIN_ID === "143" ? monad : monadTestnet;

/** Network constants from docs/SPEC.md §2.2. */
export const PERPL = {
  [monad.id]: {
    exchange: "0x34B6552d57a35a1D042CcAe1951BD1C370112a6F",
    ausd: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a",
  },
  [monadTestnet.id]: {
    exchange: "0x1964C32f0bE608E7D29302AFF5E61268E72080cc",
    ausd: "0xa9012a055bd4e0edff8ce09f960291c09d5322dc",
  },
} as const;

export const explorerTx = (hash: string, chainId: number = monad.id) =>
  `${chainId === monad.id ? monad.blockExplorers.default.url : monadTestnet.blockExplorers.default.url}/tx/${hash}`;
export const explorerAddr = (addr: string, chainId: number = monad.id) =>
  `${chainId === monad.id ? monad.blockExplorers.default.url : monadTestnet.blockExplorers.default.url}/address/${addr}`;

/** viem transport over every RPC listed for the chain, failing over on errors/429s. */
export const rpcTransport = (chain: Chain) =>
  fallback(chain.rpcUrls.default.http.map((u) => http(u, { timeout: 10_000, retryCount: 1 })));
