// pnpm privy:setup — creates the keeper's Privy server wallet with the Copas policy attached.
// Owner of both wallet and policy = a P-256 authorization key, so the app secret alone can't move or re-policy the wallet.
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cfg } from '../src/config.js';
import { privyClient } from '../src/signer.js';

const privy = privyClient();

let authKey = cfg.privy.authKey;
let newKey = false;
if (!authKey) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  authKey = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  newKey = true;
}
const publicKey = createPublicKey(createPrivateKey({ key: Buffer.from(authKey, 'base64'), format: 'der', type: 'pkcs8' }))
  .export({ format: 'der', type: 'spki' }).toString('base64');

const policyFile = resolve(cfg.ROOT, cfg.chainId === 143 ? 'privy/policy.json' : `privy/policy.${cfg.chainId}.json`);
const policyJson = JSON.parse(readFileSync(policyFile, 'utf8'));

const policy = await privy.policies().create({ ...policyJson, owner: { public_key: publicKey } });
console.log('policy created:', policy.id, `(${policyFile})`);

const wallet = await privy.wallets().create({
  chain_type: 'ethereum',
  owner: { public_key: publicKey },
  policy_ids: [policy.id], // Privy allows at most one policy per wallet
  display_name: `copas-keeper-${cfg.chainId}`,
});

console.log(`\nKeeper wallet: ${wallet.address}\n`);
console.log('Add to keeper/.env:');
console.log('SIGNER_MODE=PRIVY');
console.log(`PRIVY_WALLET_ID=${wallet.id}`);
console.log(`PRIVY_POLICY_ID=${policy.id}`);
if (newKey) console.log(`PRIVY_AUTHORIZATION_KEY=${authKey}   # secret! store it now, it is not saved anywhere`);
console.log('\nGas: enable native gas sponsorship (TEE execution + credits) for Monad in the Privy dashboard; txs go out with sponsor:true.');
