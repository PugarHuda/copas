// pnpm privy:deny-demo — the keeper wallet tries to move AUSD. The Privy policy must refuse it.
// The refusal is written to logs/deny.json (served at GET /proof/deny for the web /proof page).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeFunctionData, parseAbi, type Address } from 'viem';
import { cfg, loadDeployments } from '../src/config.js';
import { privyClient, privySend } from '../src/signer.js';

if (!cfg.privy.walletId) throw new Error('PRIVY_WALLET_ID not set (run pnpm privy:setup)');
const AUSD: Address = (() => {
  try { return loadDeployments().ausd; } catch {
    return cfg.chainId === 143 ? '0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a' : '0xa9012a055bd4e0edff8ce09f960291c09d5322dc';
  }
})();
const to = (process.argv[2] ?? '0x000000000000000000000000000000000000dEaD') as Address;
const data = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: [to, 1_000_000n] });

const privy = privyClient();
const wallet = await privy.wallets().get(cfg.privy.walletId);
const attempt = { at: new Date().toISOString(), chainId: cfg.chainId, wallet: wallet.address, walletId: wallet.id, policyIds: (wallet as any).policy_ids, request: { method: 'eth_sendTransaction', to: AUSD, call: `transfer(${to}, 1 AUSD)`, data, sponsor: cfg.privy.sponsor } };

let record: object;
try {
  const hash = await privySend(privy, wallet.id, AUSD, data);
  record = { ...attempt, outcome: 'ALLOWED', hash, warning: 'policy did NOT block this — check policy attachment!' };
} catch (e: any) {
  record = { ...attempt, outcome: 'DENIED', status: e?.status ?? null, error: e?.error ?? null, message: String(e?.message ?? e) };
}
mkdirSync(resolve(cfg.ROOT, 'logs'), { recursive: true });
writeFileSync(resolve(cfg.ROOT, 'logs/deny.json'), JSON.stringify(record, null, 2));
console.log(JSON.stringify(record, null, 2));
