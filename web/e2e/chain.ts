import { createPublicClient, http, type Abi } from "viem";
import { data as abis } from "../lib/copas/generated/abis";

/** Direct testnet reads, so the UI is checked against chain state rather than against itself. */
const client = createPublicClient({ transport: http("https://testnet-rpc.monad.xyz") });
const STATUS = ["active", "unbonded", "breached", "closed"] as const;

export async function readBook(book: `0x${string}`) {
  const lb = { address: book, abi: abis.LeaderBook as Abi };
  const [status, bond, mandate] = await Promise.all(
    (["status", "bond", "mandate"] as const).map((functionName) => client.readContract({ ...lb, functionName })),
  );
  const m = mandate as { maxDDbps: number; maxLeverageHdths: number; feeBps: number; maxNotionalCNS: bigint };
  return {
    status: STATUS[Number(status)],
    bond: Number(bond as bigint) / 1e6,
    maxDD: m.maxDDbps / 100,
    maxLeverage: m.maxLeverageHdths / 100,
    feePct: m.feeBps / 100,
    maxNotional: Number(m.maxNotionalCNS) / 1e6,
  };
}
