// Dynamic agent wallet for the ERC-8004 agent leader (#2209). The agent signs in to Dynamic with its own
// key (SIWE, no human), and trades through a 2-of-2 MPC wallet that only a Dynamic wallet-layer policy lets
// touch its LeaderBook. Secrets live in keeper/.env, non-secret wallet metadata in keeper/dynamic/agent-wallet.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DynamicEvmWalletClient } from '@dynamic-labs-wallet/node-evm';
import { createAuthClient, generateSessionKeyPair, signSessionMessage, type ServerKeyShare, type WalletMetadata } from '@dynamic-labs-wallet/node';
import { privateKeyToAccount } from 'viem/accounts';
import { cfg } from './config.js';

export const DYN_ENV = process.env.DYNAMIC_ENVIRONMENT_ID ?? 'efd0454a-9032-45ba-9bce-0a796254c83b';
// SIWE sign-ins present as the app origin; it must be on the environment's CORS allowlist.
export const DYN_ORIGIN = process.env.DYNAMIC_APP_ORIGIN ?? 'https://copas-mocha.vercel.app';
export const AGENT_WALLET_FILE = resolve(cfg.ROOT, 'dynamic/agent-wallet.json');

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`missing env ${k} (run pnpm dynamic:agent setup)`);
  return v;
};

/** Signs the agent in (its signing token = the ERC-8004 agent key) and returns an authenticated wallet client. */
export async function agentClient() {
  const signer = privateKeyToAccount(need('DYNAMIC_AGENT_SIGNING_TOKEN') as `0x${string}`);
  // Session key + JWT cached in data/ (gitignored) while the JWT lives: SIWE sign-in is limited to 10/min per IP.
  const cacheFile = resolve(cfg.ROOT, 'data/dynamic-agent-session.json');
  let cached: { jwt: string; jwk: JsonWebKey; expiresAt: number } | undefined;
  try { cached = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { /* none yet */ }
  if (!cached || cached.expiresAt * 1000 < Date.now() + 120_000) {
    const { publicKeyHex, privateKeyJwk } = await generateSessionKeyPair();
    const { jwt, expiresAt } = await createAuthClient({ environmentId: DYN_ENV, appOrigin: DYN_ORIGIN }).wallet.signIn({
      address: signer.address,
      signMessage: (message) => signer.signMessage({ message }),
      sessionPublicKey: publicKeyHex,
      statement: 'Copas agent leader signs in to its Dynamic agent wallet',
    });
    cached = { jwt, jwk: privateKeyJwk, expiresAt: expiresAt > 1e12 ? Math.floor(expiresAt / 1000) : expiresAt }; // seconds
    mkdirSync(resolve(cfg.ROOT, 'data'), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cached));
  }
  const { jwt, jwk } = cached;
  const client = new DynamicEvmWalletClient({ environmentId: DYN_ENV, enableMPCAccelerator: false });
  await client.authenticateJwt(jwt, { getSessionSignature: (m: string) => signSessionMessage(m, jwk) });
  return { client, jwt, signer: signer.address };
}

export function agentWallet(): { walletMetadata: WalletMetadata; externalServerKeyShares: ServerKeyShare[] } {
  if (!existsSync(AGENT_WALLET_FILE)) throw new Error('no dynamic/agent-wallet.json (run pnpm dynamic:agent setup)');
  return {
    walletMetadata: JSON.parse(readFileSync(AGENT_WALLET_FILE, 'utf8')).walletMetadata,
    externalServerKeyShares: JSON.parse(Buffer.from(need('DYNAMIC_AGENT_KEYSHARES'), 'base64').toString('utf8')),
  };
}
