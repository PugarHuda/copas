import { createPublicClient, http, parseAbi } from "viem";

/** Direct testnet reads, so the UI is checked against chain state rather than against itself. */
const client = createPublicClient({ transport: http("https://testnet-rpc.monad.xyz", { retryCount: 5 }) });
const STATUS = ["active", "unbonded", "breached", "closed"] as const;
// inline (lib/copas/generated is gitignored, written at prebuild)
const abi = parseAbi([
  "function status() view returns (uint8)",
  "function bond() view returns (uint256)",
  "struct Mandate { uint32 maxDDbps; uint32 maxLeverageHdths; uint32 feeBps; uint64 epochLen; uint128 maxNotionalCNS; uint256 marketsMask; }",
  "function mandate() view returns (Mandate)",
]);

export async function readBook(book: `0x${string}`) {
  const [status, bond, m] = await Promise.all([
    client.readContract({ address: book, abi, functionName: "status" }),
    client.readContract({ address: book, abi, functionName: "bond" }),
    client.readContract({ address: book, abi, functionName: "mandate" }),
  ]);
  return {
    status: STATUS[status],
    bond: Number(bond) / 1e6,
    maxDD: m.maxDDbps / 100,
    maxLeverage: m.maxLeverageHdths / 100,
    feePct: m.feeBps / 100,
    maxNotional: Number(m.maxNotionalCNS) / 1e6,
  };
}
