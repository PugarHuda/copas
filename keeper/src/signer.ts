import { createWalletClient, http, nonceManager, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PrivyClient } from '@privy-io/node';
import { cfg } from './config.js';
import { chain } from './chain.js';

export type Signer = { mode: 'LOCAL' | 'PRIVY'; address: Address; send: (to: Address, data: Hex) => Promise<Hex> };

export function privyClient() {
  if (!cfg.privy.appId || !cfg.privy.appSecret) throw new Error('PRIVY_APP_ID / PRIVY_APP_SECRET not set');
  return new PrivyClient({ appId: cfg.privy.appId, appSecret: cfg.privy.appSecret });
}

/** Privy server wallet: eth_sendTransaction via wallet RPC, gas sponsored (`sponsor: true`), policy-checked by Privy. */
export async function privySend(privy: PrivyClient, walletId: string, to: Address, data: Hex): Promise<Hex> {
  const res = await privy.wallets().ethereum().sendTransaction(walletId, {
    caip2: `eip155:${cfg.chainId}`,
    params: { transaction: { to, data, value: '0x0', chain_id: cfg.chainId } },
    sponsor: cfg.privy.sponsor,
    ...(cfg.privy.authKey ? { authorization_context: { authorization_private_keys: [cfg.privy.authKey] } } : {}),
  });
  return res.hash as Hex;
}

export async function makeSigner(): Promise<Signer> {
  if (cfg.signerMode === 'PRIVY') {
    if (!cfg.privy.walletId) throw new Error('SIGNER_MODE=PRIVY needs PRIVY_WALLET_ID (run `pnpm privy:setup`)');
    const privy = privyClient();
    const w = await privy.wallets().get(cfg.privy.walletId);
    return { mode: 'PRIVY', address: w.address as Address, send: (to, data) => privySend(privy, w.id, to, data) };
  }
  if (!cfg.privateKey) throw new Error('SIGNER_MODE=LOCAL needs KEEPER_PRIVATE_KEY');
  const account = privateKeyToAccount(cfg.privateKey as Hex, { nonceManager }); // local nonces: txs can be in flight concurrently
  const wallet = createWalletClient({ account, chain, transport: http(cfg.rpcUrl) });
  return { mode: 'LOCAL', address: account.address, send: (to, data) => wallet.sendTransaction({ to, data }) };
}

