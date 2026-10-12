/**
 * C4 transaction preview. Tenderly Simulation API when TENDERLY_ACCESS_KEY/ACCOUNT/PROJECT are set
 * (Tenderly lists Monad 143 and Monad Testnet 10143 in /api/v1/public-networks). Fallback: eth_simulateV1
 * on the Monad RPC (supported by rpc.monad.xyz) through viem `simulateCalls` with asset-change tracing,
 * plus event decoding with the Copas/Perpl ABIs in copas/abis.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Abi, type Hex, createPublicClient, decodeEventLog, erc20Abi, http } from "viem";
import { type Fetch, env, getJson, rpcUrl } from "./util.js";

export interface SimTx {
  from: `0x${string}`;
  to: `0x${string}`;
  data?: Hex;
  value?: string; // wei, decimal string
  gas?: number;
  chainId?: number; // 143 (default) or 10143
}
export interface SimResult {
  engine: "tenderly" | "eth_simulateV1";
  success: boolean;
  error?: string;
  gasUsed?: number;
  balanceChanges: { address: string; token: string; symbol?: string; decimals?: number; diff: string }[];
  events: { address: string; name?: string; args?: Record<string, unknown>; topics?: string[] }[];
  url?: string;
}


let abis: Abi[] | undefined;
function loadAbis(): Abi[] {
  if (abis) return abis;
  const dir = env("COPAS_ABIS_DIR") ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "abis");
  abis = [erc20Abi as Abi];
  if (existsSync(dir)) for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) abis.push(JSON.parse(readFileSync(join(dir, f), "utf8")));
  return abis;
}

export function decodeLog(l: { address: string; topics: string[]; data: string }) {
  for (const abi of loadAbis()) {
    try {
      const d = decodeEventLog({ abi, topics: l.topics as [Hex, ...Hex[]], data: l.data as Hex });
      return { address: l.address, name: d.eventName, args: jsonSafe(d.args) as Record<string, unknown> };
    } catch {
      /* try next abi */
    }
  }
  return { address: l.address, topics: l.topics };
}
const jsonSafe = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

export async function simulate(tx: SimTx, opts: { fetch?: Fetch } = {}): Promise<SimResult> {
  const chainId = tx.chainId ?? 143;
  const key = env("TENDERLY_ACCESS_KEY");
  const account = env("TENDERLY_ACCOUNT");
  const project = env("TENDERLY_PROJECT");
  if (key && account && project) {
    const j = await getJson<any>(
      `https://api.tenderly.co/api/v1/account/${account}/project/${project}/simulate`,
      {
        method: "POST",
        headers: { "X-Access-Key": key, "content-type": "application/json" },
        body: JSON.stringify({ network_id: String(chainId), from: tx.from, to: tx.to, input: tx.data ?? "0x", value: tx.value ?? "0", gas: tx.gas ?? 8_000_000, save: true, save_if_fails: true, simulation_type: "full" }),
      },
      opts.fetch,
    );
    const t = j.transaction ?? {};
    const info = t.transaction_info ?? {};
    return {
      engine: "tenderly",
      success: !!t.status,
      error: t.error_message || undefined,
      gasUsed: t.gas_used,
      balanceChanges: (info.asset_changes ?? []).map((a: any) => ({
        address: a.to ?? a.from,
        token: a.token_info?.contract_address ?? "native",
        symbol: a.token_info?.symbol,
        decimals: a.token_info?.decimals,
        diff: `${a.type === "Transfer" && a.from?.toLowerCase() === tx.from.toLowerCase() ? "-" : ""}${a.raw_amount ?? a.amount}`,
      })),
      events: (info.logs ?? []).map((l: any) => ({ address: l.raw?.address, name: l.name ?? undefined, args: l.inputs ? Object.fromEntries(l.inputs.map((i: any) => [i.soltype?.name, i.value])) : undefined, topics: l.name ? undefined : l.raw?.topics })),
      url: j.simulation?.id ? `https://dashboard.tenderly.co/${account}/${project}/simulator/${j.simulation.id}` : undefined,
    };
  }

  // fallback: eth_simulateV1 with asset tracing (viem decodes ERC-20 + native balance diffs of `from`)
  const client = createPublicClient({ transport: http(rpcUrl(chainId), opts.fetch ? { fetchFn: opts.fetch } : undefined) });
  const { results, assetChanges } = await client.simulateCalls({
    account: tx.from,
    calls: [{ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined }],
    traceAssetChanges: true,
  });
  const r = results[0];
  return {
    engine: "eth_simulateV1",
    success: r.status === "success",
    error: r.status === "failure" ? ((r.error as any)?.shortMessage ?? r.error?.message)?.split("\n")[0] : undefined,
    gasUsed: Number(r.gasUsed),
    balanceChanges: assetChanges
      .filter((a) => a.value.diff !== 0n)
      .map((a) => ({ address: tx.from, token: a.token.address, symbol: a.token.symbol, decimals: a.token.decimals, diff: a.value.diff.toString() })),
    events: (r.logs ?? []).map((l) => decodeLog(l as any)),
  };
}
