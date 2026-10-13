"use server";
import { createPublicClient, parseAbi, type Hex } from "viem";
import { copasChain, rpcTransport } from "../chains";
import { envioQuery, indexerConfigured } from "../perpl/indexer";

/** Owners of vaults actively following `book`: Envio first, then HyperSync logs (the Envio deployment indexes mainnet Perpl, not testnet Copas). */
export async function followerOwners(book: string): Promise<string[]> {
  const fromEnvio = await envioOwners(book);
  return fromEnvio.length ? fromEnvio : hypersyncOwners(book).catch(() => []);
}

async function envioOwners(book: string): Promise<string[]> {
  if (!indexerConfigured()) return [];
  try {
    const r = await envioQuery<{ Follower: { vault: { owner: string } }[] }>(
      `query($b: String!) { Follower(where: { leader_id: { _eq: $b }, active: { _eq: true } }) { vault { owner } } }`,
      { b: book.toLowerCase() },
    );
    return [...new Set(r.Follower.map((f) => f.vault.owner.toLowerCase()))];
  } catch {
    return [];
  }
}

const REGISTERED = "0xdd66529c92aa9258db3cfecf0e7ada39993533fb347cc155d669949482c86a02"; // FollowerRegistered(address,uint256,uint256)
const UNREGISTERED = "0x4ab97a15585fa252c5c038818bd51a4b6a3a7886a9988164a843a4046dc1b40f"; // FollowerUnregistered(address,uint256)

/** FollowerRegistered/Unregistered on the LeaderBook (vault is topic1), then each live vault's owner(). Testnet only, like kuru.readFills. */
async function hypersyncOwners(book: string): Promise<string[]> {
  const token = process.env.ENVIO_API_TOKEN;
  if (!token || copasChain.id !== 10143) return [];
  const r = await fetch("https://monad-testnet.hypersync.xyz/query", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      from_block: 69_000_000, // before the Copas testnet deploy (11 Oct 2026)
      logs: [{ address: [book], topics: [[REGISTERED, UNREGISTERED]] }],
      field_selection: { log: ["block_number", "log_index", "topic0", "topic1"] },
    }),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`hypersync ${r.status}`);
  const j = (await r.json()) as { data: { logs: { block_number: number; log_index: number; topic0: Hex; topic1: Hex }[] }[] };
  const live = new Set<Hex>();
  for (const l of j.data.flatMap((d) => d.logs).sort((a, b) => a.block_number - b.block_number || a.log_index - b.log_index)) {
    const vault = `0x${l.topic1.slice(26)}` as Hex;
    if (l.topic0 === REGISTERED) live.add(vault);
    else live.delete(vault);
  }
  const client = createPublicClient({ chain: copasChain, transport: rpcTransport(copasChain) });
  const abi = parseAbi(["function owner() view returns (address)"]);
  const owners = await Promise.all([...live].map((address) => client.readContract({ address, abi, functionName: "owner" })));
  return [...new Set(owners.map((o) => o.toLowerCase()))];
}
