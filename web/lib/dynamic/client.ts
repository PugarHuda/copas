"use client";
// Dynamic (dynamic.xyz) embedded wallet: email OTP -> MPC wallet on Monad testnet, plus delegated access.
// Loaded lazily (import("@/lib/dynamic/client")) so passkey users never download the SDK.
import { createDynamicClient, getWalletAccounts, initializeClient, isSignedIn, logout, sendEmailOTP, switchActiveNetwork, verifyOTP, waitForClientInitialized, type OTPVerification, type WalletAccount } from "@dynamic-labs-sdk/client";
import { buildAllowPolicyRule, createWaasWalletAccounts, delegateWaasKeyShares, getChainsMissingWaasWalletAccounts, hasDelegatedAccess, revokeWaasDelegation, WaasChainEnum } from "@dynamic-labs-sdk/client/waas";
import { addWaasEvmExtension } from "@dynamic-labs-sdk/evm/waas";
import { createWalletClientForWalletAccount } from "@dynamic-labs-sdk/evm/viem";
import { toAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import { copasChain } from "../chains";

export const DYNAMIC_ENV = process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID ?? "";

let ready: Promise<void> | undefined;
function init() {
  ready ??= (async () => {
    createDynamicClient({ autoInitialize: false, environmentId: DYNAMIC_ENV, metadata: { name: "Copas", universalLink: window.location.origin } });
    addWaasEvmExtension();
    await initializeClient();
    await waitForClientInitialized();
  })();
  return ready;
}

let pending: OTPVerification | undefined;
export async function sendCode(email: string) {
  await init();
  pending = await sendEmailOTP({ email });
}

/** Verifies the OTP and makes sure the user has an EVM embedded wallet. */
export async function verifyCode(code: string) {
  if (!pending) throw new Error("Request a code first.");
  await verifyOTP({ otpVerification: pending, verificationToken: code });
  pending = undefined;
  const missing = getChainsMissingWaasWalletAccounts();
  if (missing.length) await createWaasWalletAccounts({ chains: missing });
  return session();
}

function evmWallet(): WalletAccount | undefined {
  return getWalletAccounts().find((w) => w.chain === "EVM");
}

/** Restores a session persisted by the SDK, if any. */
export async function restore() {
  await init();
  return isSignedIn() ? session() : undefined;
}

/** A viem LocalAccount backed by the MPC wallet: Copas' write path (useCopasWrite) signs with it like a passkey account. */
async function session(): Promise<{ address: `0x${string}`; account: LocalAccount }> {
  const wa = evmWallet();
  if (!wa) throw new Error("No Dynamic EVM wallet on this account.");
  await switchActiveNetwork({ walletAccount: wa, networkId: String(copasChain.id) });
  const wc = await createWalletClientForWalletAccount({ walletAccount: wa });
  const address = wa.address as `0x${string}`;
  const account = toAccount({
    address,
    signMessage: ({ message }) => wc.signMessage({ account: wc.account, message }),
    signTypedData: (td) => wc.signTypedData({ account: wc.account, ...(td as object) } as never),
    signTransaction: (tx) => wc.signTransaction({ account: wc.account, chain: copasChain, ...(tx as object) } as never),
  });
  return { address, account };
}

export async function signOutDynamic() {
  await init();
  await logout();
}

export function delegated() {
  const wa = evmWallet();
  return wa ? hasDelegatedAccess({ walletAccount: wa }) : false;
}

/**
 * Grants Copas' server a delegated MPC share. The delegated signer is seeded with an allowlist:
 * only `unfollow()` on the user's own vaults, only on Monad testnet. Dynamic refuses anything else at signing time.
 */
export async function delegate(vaults: `0x${string}`[]) {
  const wa = evmWallet();
  if (!wa) throw new Error("No Dynamic wallet.");
  await delegateWaasKeyShares({
    walletAccount: wa,
    initialSignerRules: [
      buildAllowPolicyRule({
        name: "Copas guard: FollowerVault.unfollow only",
        chain: WaasChainEnum.Evm,
        chainIds: [copasChain.id],
        addresses: vaults,
        functionName: "unfollow",
        contractAbi: [{ type: "function", name: "unfollow", inputs: [], outputs: [], stateMutability: "nonpayable" }],
      } as never),
    ],
  });
}

export async function revoke() {
  const wa = evmWallet();
  if (!wa) throw new Error("No Dynamic wallet.");
  await revokeWaasDelegation({ walletAccount: wa });
}
