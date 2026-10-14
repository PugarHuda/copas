import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, type Abi, type Address } from 'viem';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(resolve(ROOT, '.env')); } catch { /* no .env: plain env vars */ }

export const log = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}) => {
  if (level === 'debug' && !process.env.DEBUG) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
};

const env = (k: string, d?: string) => {
  const v = process.env[k];
  if (v !== undefined && v !== '') return v;
  if (d === undefined) throw new Error(`missing env ${k} (see .env.example)`);
  return d;
};
const flag = (k: string, d = false) => ['1', 'true', 'yes'].includes(env(k, String(d)).toLowerCase());

export const CHAIN_ID = Number(env('CHAIN_ID', '10143'));
if (CHAIN_ID !== 143 && CHAIN_ID !== 10143) throw new Error(`CHAIN_ID must be 143 or 10143, got ${CHAIN_ID}`);
const MAINNET = CHAIN_ID === 143;

export const REPUTATION_8004: Address = MAINNET
  ? '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63'
  : '0x8004B663056A597Dffe9eCcC1965A193B7388713';

export type Deployments = {
  registry: Address; breachMarket: Address; agentRegistry: Address;
  exchange: Address; ausd: Address; identity8004: Address; block: number;
};

export function loadDeployments(): Deployments {
  const path = resolve(ROOT, env('DEPLOYMENTS_FILE', `../contracts/deployments/${CHAIN_ID}.json`));
  if (!existsSync(path)) {
    throw new Error(`deployments file not found: ${path}. Deploy contracts first (contracts/script/Deploy.s.sol) or set DEPLOYMENTS_FILE.`);
  }
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const keys = ['registry', 'breachMarket', 'agentRegistry', 'exchange', 'ausd', 'identity8004'] as const;
  const missing = keys.filter((k) => !j[k]);
  if (missing.length) throw new Error(`deployments file ${path} is missing keys: ${missing.join(', ')}`);
  return { ...Object.fromEntries(keys.map((k) => [k, getAddress(j[k])])), block: Number(j.block ?? 0) } as Deployments;
}

const abisDir = resolve(ROOT, env('ABIS_DIR', '../abis'));
const abi = (name: string) => JSON.parse(readFileSync(resolve(abisDir, `${name}.json`), 'utf8')) as Abi;
export const ABI = {
  registry: abi('CopasRegistry'),
  leader: abi('LeaderBook'),
  vault: abi('FollowerVault'),
  breachMarket: abi('BreachMarket'),
  agentRegistry: abi('AgentLeaderRegistry'),
  exchange: abi('PerplExchange'),
};

export const cfg = {
  ROOT,
  chainId: CHAIN_ID,
  rpcUrl: env('MONAD_RPC_URL', MAINNET ? 'https://rpc.monad.xyz' : 'https://testnet-rpc.monad.xyz').trim(),
  wsUrl: env('MONAD_WS_URL', ''),
  startBlock: env('START_BLOCK', ''),
  pollMs: Number(env('POLL_MS', '1500')),
  logChunk: BigInt(env('LOG_CHUNK_BLOCKS', '100')), // public RPC caps eth_getLogs at 100 blocks
  checkpointEvery: BigInt(env('CHECKPOINT_EVERY_BLOCKS', '150')),
  unwindEvery: BigInt(env('UNWIND_SCAN_EVERY_BLOCKS', '50')),
  ddAlertFraction: Number(env('DD_ALERT_FRACTION', '0.8')),
  signerMode: env('SIGNER_MODE', 'LOCAL').toUpperCase() as 'LOCAL' | 'PRIVY',
  privateKey: env('KEEPER_PRIVATE_KEY', ''),
  privy: {
    appId: env('PRIVY_APP_ID', ''),
    appSecret: env('PRIVY_APP_SECRET', ''),
    authKey: env('PRIVY_AUTHORIZATION_KEY', '').replace(/^wallet-auth:/, ''),
    walletId: env('PRIVY_WALLET_ID', ''),
    sponsor: flag('PRIVY_SPONSOR', true),
  },
  enableSettle: flag('ENABLE_BREACH_SETTLE', true),
  enable8004: flag('ENABLE_8004_FEEDBACK', false),
  telegramToken: env('TELEGRAM_BOT_TOKEN', ''),
  telegramChatId: env('TELEGRAM_CHAT_ID', ''), // channel the hosted tick posts to
  alchemyKey: env('ALCHEMY_WEBHOOK_SIGNING_KEY', ''),
  httpPort: Number(env('PORT', '8787')),
  dataDir: resolve(ROOT, env('DATA_DIR', 'data')),
};
