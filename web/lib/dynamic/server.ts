import "server-only";
// Dynamic delegated access, server side: the follower's embedded wallet delegates an MPC share to Copas
// (webhook wallet.delegation.created). Copas uses it for one thing only: `unfollow()` on that follower's own
// vault when a protective rule holds. Dynamic's delegated-signer policy (seeded by the client) refuses anything else.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { del, get, put } from "@vercel/blob";
import { createPublicClient, encodeFunctionData, type Abi } from "viem";
import { copasChain, rpcTransport } from "../chains";
import { copasAbi, deployment } from "../copas/contracts";

export const DYN_ENV = process.env.NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID ?? "";
const pem = () => {
  const b64 = process.env.DYNAMIC_DELEGATION_PRIVATE_KEY;
  if (!b64) throw new Error("DYNAMIC_DELEGATION_PRIVATE_KEY not set");
  return Buffer.from(b64, "base64").toString("utf8");
};
const pub = createPublicClient({ chain: copasChain, transport: rpcTransport(copasChain) });

export { verifyWebhook } from "./webhookSig";

// The webhook Copas registered (POST /environments/{env}/webhooks) for wallet.delegation.created/revoked.
const WEBHOOK_ID = process.env.DYNAMIC_WEBHOOK_ID ?? "67018494-494f-4e40-a9e4-e10ba639edf9";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Without a shared secret the request body is never trusted: the claimed message must be in Dynamic's delivery log
 * for our webhook (admin API, our API token, TLS), and the copy Dynamic returns is what we act on.
 */
export async function dynamicMessage(claim: { webhookId?: unknown; messageId?: unknown; eventId?: unknown }) {
  if (claim.webhookId !== WEBHOOK_ID || typeof claim.messageId !== "string" || !UUID.test(claim.messageId)) return null;
  const r = await fetch(`https://app.dynamicauth.com/api/v0/environments/${DYN_ENV}/webhooks/${WEBHOOK_ID}/messages/${claim.messageId}`, {
    headers: { authorization: `Bearer ${process.env.DYNAMIC_API_TOKEN}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { data?: { request?: { body?: Record<string, unknown> } }[] };
  const body = j.data?.find((d) => d.request?.body)?.request?.body;
  return body && body.eventId === claim.eventId && body.messageId === claim.messageId ? body : null;
}

type WalletInfo = { address?: string; delegated: boolean | null };
/** Wallet record from Dynamic's admin API: who owns a walletId, and whether a delegated share still exists for it. */
export async function dynamicWallet(walletId: string): Promise<WalletInfo | null> {
  if (!/^[0-9a-f-]{36}$/i.test(walletId)) return null;
  const r = await fetch(`https://app.dynamicauth.com/api/v0/environments/${DYN_ENV}/waas/${walletId}`, {
    headers: { authorization: `Bearer ${process.env.DYNAMIC_API_TOKEN}` },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const w = ((await r.json()) as { wallet?: { accountAddress?: string; keyShares?: { backupLocation: string }[] } }).wallet;
  return { address: w?.accountAddress, delegated: w?.keyShares ? w.keyShares.some((k) => k.backupLocation === "delegated") : null };
}

// ---------------------------------------------------------------- storage (private Blob, AES-256-GCM at rest)
type Delegation = { walletId: string; address: `0x${string}`; userId?: string; shareSetId?: string; walletApiKey: string; keyShare: unknown; at: string };
const key = (addr: string) => `dyn/deleg/${addr.toLowerCase()}.json`;
const aes = () => createHash("sha256").update(`copas-dyn-deleg|${pem()}`).digest();

export async function saveDelegation(d: Delegation) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", aes(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(d)), c.final()]);
  const body = JSON.stringify({ v: 1, walletId: d.walletId, address: d.address, at: d.at, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") });
  await put(key(d.address), body, { access: "private", allowOverwrite: true, addRandomSuffix: false, contentType: "application/json" });
}

export async function loadDelegation(addr: string): Promise<Delegation | null> {
  const r = await get(key(addr), { access: "private", useCache: false }).catch(() => null);
  if (!r || r.statusCode !== 200) return null;
  const j = JSON.parse(await new Response(r.stream).text()) as { iv: string; tag: string; ct: string };
  const d = createDecipheriv("aes-256-gcm", aes(), Buffer.from(j.iv, "base64"));
  d.setAuthTag(Buffer.from(j.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(j.ct, "base64")), d.final()]).toString("utf8"));
}

export const dropDelegation = (addr: string) => del(key(addr)).catch(() => undefined);

// ---------------------------------------------------------------- the guard
const VAULT = copasAbi.FollowerVault as Abi;
const LB = copasAbi.LeaderBook as Abi;
const STATUS = ["active", "unbonded", "breached", "closed"] as const;

export type GuardCheck = { vault: `0x${string}`; leader: `0x${string}`; status: string; ddPct: number; maxDDPct: number; consentOk: boolean | null; reason: string | null };

/** Protective rules, evaluated from chain state only. Any reason -> stop copying (unfollow). Funds never move. */
export async function guardChecks(owner: `0x${string}`): Promise<GuardCheck[]> {
  if (!deployment?.registry) return [];
  const vaults = (await pub.readContract({ address: deployment.registry, abi: copasAbi.CopasRegistry as Abi, functionName: "vaultsOf", args: [owner] })) as `0x${string}`[];
  const out: GuardCheck[] = [];
  for (const v of vaults) {
    const [following, leader, consent] = await pub.multicall({
      contracts: [{ address: v, abi: VAULT, functionName: "following" }, { address: v, abi: VAULT, functionName: "leader" }, { address: v, abi: VAULT, functionName: "consentOk" }],
      allowFailure: true,
    });
    if (following.result !== true) continue;
    const lb = leader.result as `0x${string}`;
    const [status, peak, unit, mandate] = (await pub.multicall({
      contracts: [{ address: lb, abi: LB, functionName: "status" }, { address: lb, abi: LB, functionName: "peakUnitPrice" }, { address: lb, abi: LB, functionName: "unitPrice" }, { address: lb, abi: LB, functionName: "mandate" }],
      allowFailure: false,
    })) as [number, bigint, [bigint, boolean], { maxDDbps: number }];
    const ddPct = peak > 0n && unit[1] && unit[0] < peak ? Number(((peak - unit[0]) * 10_000n) / peak) / 100 : 0;
    const maxDDPct = Number(mandate.maxDDbps) / 100;
    const consentOk = consent.status === "success" ? (consent.result as boolean) : null;
    const st = STATUS[Number(status)] ?? String(status);
    const reason =
      st !== "active" ? `leader is ${st}` : ddPct >= maxDDPct * 0.8 ? `leader drawdown ${ddPct.toFixed(2)}% is past 80% of its ${maxDDPct}% limit` : consentOk === false ? "leader loosened its mandate and you have not accepted the new terms" : null;
    out.push({ vault: v, leader: lb, status: st, ddPct, maxDDPct, consentOk, reason });
  }
  return out;
}

/** Signs `vault.unfollow()` with the delegated share and broadcasts it. */
export async function delegatedUnfollow(d: Delegation, vault: `0x${string}`) {
  const { createDelegatedEvmWalletClient, delegatedSignTransaction } = await import("@dynamic-labs-wallet/node-evm");
  const client = createDelegatedEvmWalletClient({ environmentId: DYN_ENV, apiKey: process.env.DYNAMIC_API_TOKEN! });
  const data = encodeFunctionData({ abi: VAULT, functionName: "unfollow" });
  const [nonce, gas, fees] = await Promise.all([
    pub.getTransactionCount({ address: d.address, blockTag: "pending" }),
    pub.estimateGas({ account: d.address, to: vault, data }),
    pub.estimateFeesPerGas(),
  ]);
  const signed = await delegatedSignTransaction(client, {
    walletId: d.walletId,
    shareSetId: d.shareSetId,
    walletApiKey: d.walletApiKey,
    keyShare: d.keyShare as never,
    transaction: { type: "eip1559", chainId: copasChain.id, to: vault, data, nonce, gas: (gas * 13n) / 10n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas },
  });
  const hash = await pub.sendRawTransaction({ serializedTransaction: signed as `0x${string}` });
  const r = await pub.waitForTransactionReceipt({ hash });
  return { hash, status: r.status };
}

/** Delegated signing of a call the delegated-signer policy does not allow (vault.withdraw). Dynamic must refuse it. */
export async function delegatedForbidden(d: Delegation, vault: `0x${string}`) {
  const { createDelegatedEvmWalletClient, delegatedSignTransaction } = await import("@dynamic-labs-wallet/node-evm");
  const client = createDelegatedEvmWalletClient({ environmentId: DYN_ENV, apiKey: process.env.DYNAMIC_API_TOKEN! });
  const data = encodeFunctionData({ abi: VAULT, functionName: "withdraw", args: [1n] });
  const nonce = await pub.getTransactionCount({ address: d.address, blockTag: "pending" });
  const fees = await pub.estimateFeesPerGas();
  try {
    await delegatedSignTransaction(client, {
      walletId: d.walletId,
      shareSetId: d.shareSetId,
      walletApiKey: d.walletApiKey,
      keyShare: d.keyShare as never,
      transaction: { type: "eip1559", chainId: copasChain.id, to: vault, data, nonce, gas: 300_000n, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas },
    });
    return { outcome: "SIGNED" as const }; // never broadcast
  } catch (e) {
    return { outcome: "DENIED" as const, error: (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300) };
  }
}
