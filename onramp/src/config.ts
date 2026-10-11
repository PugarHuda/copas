// Addresses and asset ids, verified live on 3 Oct 2026 (see test/fixtures and README "Verification log").
import type { Address } from 'viem';

export const MONAD = {
  chainId: 143,
  rpc: 'https://rpc.monad.xyz',
  USDC: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' as Address,
  AUSD: '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' as Address,
  WMON: '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A' as Address,
  MON: '0x0000000000000000000000000000000000000000' as Address, // Kuru Flow native convention
  KURU_FLOW_ENTRYPOINT: '0xb3e6778480b2E488385E8205eA05E20060B813cb' as Address,
  KURU_ROUTER: '0xd651346d7c789536ebf06dc72aE3C8502cd695CC' as Address, // deployProxy is owner-only (Safe) on mainnet
} as const;

export const MONAD_TESTNET = {
  chainId: 10143,
  rpc: 'https://testnet-rpc.monad.xyz',
  AUSD: '0xa9012a055bd4e0edff8ce09f960291c09d5322dc' as Address, // Perpl testnet AUSD
  KURU_ROUTER: '0x7EFbE105Ca7415dE98F96622173458ac1c054630' as Address, // Kuru V1 legacy, deployProxy permissionless
} as const;

/** NEAR Intents asset ids. Monad only supports MON, USDC, USDT0 (no AUSD). */
export const ASSETS = {
  monad: {
    USDC: 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx',
    USDT0: 'nep245:v2_1.omni.hot.tg:143_4EJiJxSALvGoTZbnc8K7Ft9533et',
    MON: 'nep245:v2_1.omni.hot.tg:143_11111111111111111111',
  },
} as const;

export type SourceToken = {
  chain: 'base' | 'arb' | 'eth' | 'sol' | 'bsc';
  symbol: string;
  assetId: string;
  contractAddress?: string;
  decimals: number;
};

/** Source tokens offered in the UI. Taken from GET /api/v1/supported_tokens (Intents Connect, "in"). */
export const SOURCES: SourceToken[] = [
  { chain: 'base', symbol: 'USDC', assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6 },
  { chain: 'base', symbol: 'ETH', assetId: 'nep141:base.omft.near', decimals: 18 },
  { chain: 'arb', symbol: 'USDC', assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', contractAddress: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6 },
  { chain: 'arb', symbol: 'ETH', assetId: 'nep141:arb.omft.near', decimals: 18 },
  { chain: 'eth', symbol: 'USDC', assetId: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6 },
  { chain: 'eth', symbol: 'ETH', assetId: 'nep141:eth.omft.near', decimals: 18 },
  { chain: 'sol', symbol: 'USDC', assetId: 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', contractAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  { chain: 'sol', symbol: 'SOL', assetId: 'nep141:sol.omft.near', decimals: 9 },
  { chain: 'bsc', symbol: 'USDT', assetId: 'nep245:v2_1.omni.hot.tg:56_2CMMyVTGZkeyNZTSvS5sarzfir6g', contractAddress: '0x55d398326f99059ff775485246999027b3197955', decimals: 18 },
];

export const env = (k: string): string | undefined => process.env[k] || undefined;
