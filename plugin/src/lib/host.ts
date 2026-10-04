// Host glue: deployments, the active wallet address, contract reads, and the ONLY write path
// (ctx.walletExecutor). This plugin never sees keys, sessions or tokens.
import { CommandError, type CommandIO, InputFieldType, type PluginCommandContext, type PublicClient } from "@metamask/agent-wallet/plugin";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, isAddress, zeroAddress } from "viem";
import {
  abi,
  encode,
  AUSD_DECIMALS,
  DAY_MS,
  type FollowParams,
  InputError,
  parseAddress,
  parseAusd,
  parseChainId,
  type RegistryMarket,
  type Tx,
  type WithdrawEntry,
} from "./core.ts";

export type Deployment = { registry: Address; exchange: Address; ausd: Address; breachMarket?: Address; agentRegistry?: Address };

/** Flags shared by every command. */
export const commonInputs = {
  chainId: {
    type: InputFieldType.Text,
    flag: "chain-id",
    env: "COPAS_CHAIN_ID",
    message: "Monad chain: 143 (mainnet, default) or 10143 (testnet)",
    required: false,
    prompt: false,
  },
} as const;

export const vaultInput = {
  vault: {
    type: InputFieldType.Text,
    flag: "vault",
    message: "FollowerVault address (default: your latest vault)",
    required: false,
    prompt: false,
  },
} as const;

/** Converts plugin input errors into host CommandErrors with a stable code. */
export function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof InputError) throw fail(e.code, e.message);
    throw e;
  }
}

// ------------------------------------------------------------------ deployments

function deploymentDirs(): string[] {
  const dirs = [];
  if (process.env.COPAS_DEPLOYMENTS_DIR) dirs.push(process.env.COPAS_DEPLOYMENTS_DIR);
  dirs.push(fileURLToPath(new URL("../../deployments/", import.meta.url)));
  dirs.push(fileURLToPath(new URL("../../../contracts/deployments/", import.meta.url))); // monorepo dev link
  return dirs;
}

export function loadDeployment(chainId: number): Deployment {
  for (const dir of deploymentDirs()) {
    const file = join(dir, `${chainId}.json`);
    if (!existsSync(file)) continue;
    const d = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    const missing = ["registry", "exchange", "ausd"].filter((k) => !d[k] || !isAddress(d[k]) || d[k] === zeroAddress);
    if (missing.length) throw fail("COPAS_DEPLOYMENT_INVALID", `${file} is missing ${missing.join(", ")}.`, "Re-run the Copas deploy script or fix the file.");
    return d as unknown as Deployment;
  }
  throw fail(
    "COPAS_NOT_DEPLOYED",
    `No Copas deployment found for chain ${chainId}.`,
    `Expected deployments/${chainId}.json with keys registry, exchange, ausd (breachMarket, agentRegistry optional). Set COPAS_DEPLOYMENTS_DIR or run 'npm run sync' in the plugin after deploying.`,
  );
}

// ------------------------------------------------------------------ chain session

export type Session = {
  chainId: number;
  dep: Deployment;
  client: PublicClient;
  read: <T>(address: Address, name: "FollowerVault" | "LeaderBook" | "CopasRegistry" | "PerplExchange", fn: string, args?: unknown[]) => Promise<T>;
};

export function session(ctx: PluginCommandContext, rawChainId: string | undefined): Session {
  const chainId = wrap(() => parseChainId(rawChainId));
  const dep = loadDeployment(chainId);
  const client = ctx.publicClient(chainId);
  const read = <T>(address: Address, name: Parameters<typeof abi>[0], fn: string, args: unknown[] = []) =>
    client.readContract({ address, abi: abi(name), functionName: fn, args }) as Promise<T>;
  return { chainId, dep, client, read };
}

export async function registryMarkets(s: Session): Promise<RegistryMarket[]> {
  const ms = await s.read<readonly { perpId: number; priceDecimals: number; lotDecimals: number }[]>(s.dep.registry, "CopasRegistry", "markets");
  return ms.map((m) => ({ perpId: Number(m.perpId), priceDecimals: Number(m.priceDecimals), lotDecimals: Number(m.lotDecimals) }));
}

export async function readParams(s: Session, vault: Address): Promise<FollowParams> {
  const p = await s.read<FollowParams>(vault, "FollowerVault", "params");
  return { ...p, ratioBps: Number(p.ratioBps), maxLeverageHdths: Number(p.maxLeverageHdths), maxChaseBps: Number(p.maxChaseBps), priceBandBps: Number(p.priceBandBps), stopLossBps: Number(p.stopLossBps) };
}

// ------------------------------------------------------------------ wallet

/** EVM address of the wallet the host will sign with (selected wallet, else the first EVM wallet). */
export function activeAddress(ctx: PluginCommandContext): Address {
  const state = ctx.walletStateManager.read() as {
    byokWallets?: { address?: string }[];
    remoteWallets?: { address?: string }[];
    selectedWallet?: { ref?: { address?: string } | string };
  };
  const ref = state.selectedWallet?.ref;
  const selected = typeof ref === "string" ? ref : ref?.address;
  if (selected && isAddress(selected)) return selected;
  const evm = [...(state.remoteWallets ?? []), ...(state.byokWallets ?? [])].find((w) => w.address && isAddress(w.address));
  if (!evm?.address) throw fail("COPAS_NO_WALLET", "No EVM wallet found in the Agent Wallet.", "Run 'mm init' first.");
  return evm.address as Address;
}

/** The vault to act on: --vault, else the newest vault owned by the active wallet. */
export async function resolveVault(ctx: PluginCommandContext, s: Session, raw: string | undefined): Promise<Address> {
  if (raw) {
    const v = wrap(() => parseAddress(raw, "--vault"));
    if (!(await s.read<boolean>(s.dep.registry, "CopasRegistry", "isVault", [v]))) throw fail("COPAS_NOT_A_VAULT", `${v} is not a Copas FollowerVault on chain ${s.chainId}.`);
    return v;
  }
  const vaults = await s.read<readonly Address[]>(s.dep.registry, "CopasRegistry", "vaultsOf", [activeAddress(ctx)]);
  const v = vaults.at(-1);
  if (!v) throw fail("COPAS_NO_VAULT", "You have no FollowerVault on this chain yet.", "Run 'mm copas vault --create'.");
  return v;
}

// ------------------------------------------------------------------ the only write path

export type Sent = { step: string; hash: string; status: string };

/** Submits one transaction through the Agent Wallet executor (signing, policy and MFA stay with the host). */
export async function send(ctx: PluginCommandContext, io: CommandIO, commandId: string, chainId: number, tx: Tx, step: string, details?: Record<string, string>): Promise<Sent> {
  const exec = await ctx.walletExecutor(io, commandId, { emitStepNotices: true });
  const res = await exec(
    { kind: "transaction", chainId, transaction: { to: tx.to, data: tx.data }, intent: { summary: `Copas: ${step}`, action: "custom", details } },
    { waitForReceipt: true },
  );
  if (res.kind !== "transaction" || res.failureCode || !res.hash || /FAIL|DENIED|EXPIRED|REVERT|REJECT/i.test(res.status)) {
    throw fail(
      "COPAS_TX_FAILED",
      `${step} did not complete (status ${res.status}${res.failureCode ? `, ${res.failureCode}` : ""}).`,
      res.failureDescription ?? "Check 'mm wallet requests list' for the job state.",
    );
  }
  return { step, hash: res.hash, status: res.status };
}

// ------------------------------------------------------------------ plugin config + outflow ledger

const copasHome = () => process.env.COPAS_HOME ?? join(homedir(), ".copas");

// ponytail: local JSON ledger, so the cap is per machine; an on-chain Withdrawn-event scan would make it global.
export function readWithdrawLedger(): WithdrawEntry[] {
  const f = join(copasHome(), "withdrawals.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as WithdrawEntry[]) : [];
}

export function appendWithdraw(e: WithdrawEntry) {
  mkdirSync(copasHome(), { recursive: true });
  const kept = readWithdrawLedger().filter((x) => Date.now() - x.ts < 7 * DAY_MS);
  writeFileSync(join(copasHome(), "withdrawals.json"), JSON.stringify([...kept, e], null, 2));
}

/** maxWithdrawPerDay in AUSD from env COPAS_MAX_WITHDRAW_PER_DAY or ~/.copas/config.json. Default 100 AUSD (the mainnet vault cap). */
export function maxWithdrawPerDay(): bigint {
  let raw = process.env.COPAS_MAX_WITHDRAW_PER_DAY;
  const f = join(copasHome(), "config.json");
  if (!raw && existsSync(f)) raw = String((JSON.parse(readFileSync(f, "utf8")) as { maxWithdrawPerDay?: string | number }).maxWithdrawPerDay ?? "");
  return raw ? wrap(() => parseAusd(raw, "maxWithdrawPerDay")) : 100n * 10n ** BigInt(AUSD_DECIMALS);
}

export const refInput = {
  ref: {
    type: InputFieldType.Text,
    flag: "ref",
    message: "Optional referrer address, set once per vault (FollowerVault.setReferrer)",
    required: false,
    prompt: false,
  },
} as const;

/** Sets the one-time referrer if given. Skips (with a note) when one is already set. */
export async function maybeSetReferrer(ctx: PluginCommandContext, io: CommandIO, commandId: string, s: Session, vault: Address, raw: string | undefined, owner: Address): Promise<Sent | null> {
  if (!raw) return null;
  const ref = wrap(() => parseAddress(raw, "--ref"));
  if (ref.toLowerCase() === owner.toLowerCase()) throw fail("COPAS_INVALID_REFERRER", "You cannot refer yourself.");
  const current = await s.read<Address>(vault, "FollowerVault", "referrer");
  if (current !== zeroAddress) {
    io.emit(`Referrer already set to ${current} (one-time); --ref ignored.`);
    return null;
  }
  return send(ctx, io, commandId, s.chainId, encode.setReferrer(vault, ref), "set referrer", { vault, referrer: ref });
}

/** CommandError with a default hint (the host requires a non-empty hint). */
export function fail(code: string, message: string, hint = "Run 'mm copas status' or see skills/copas/SKILL.md."): CommandError {
  return new CommandError(code, message, hint);
}
