import { copasVault } from "@/lib/copas/indexer";
import { getLeader, recentSynced, vaultState } from "@/lib/copas/data";
import { MeView } from "./MeView";

type SP = Promise<{ owner?: string; vault?: string }>;

/** The connected wallet is client-only, so MeView pushes it into ?owner=. State is read from chain, history from the indexer (RPC logs as fallback). */
export default async function MePage({ searchParams }: { searchParams: SP }) {
  const { owner, vault } = await searchParams;
  const live = await copasVault({ owner, vault });
  const chain = await vaultState({ owner, vault: live?.vault ?? vault });
  const [leader, rpcFills] = await Promise.all([
    chain?.leader ? getLeader(chain.leader) : null,
    chain && !live?.fills.length ? recentSynced(chain.vault).catch(() => []) : [],
  ]);
  const fills = live?.fills.length ? { rows: live.fills, src: "indexer" as const } : { rows: rpcFills, src: "rpc" as const };
  return <MeView live={live} chain={chain} leader={leader} fills={fills} query={owner ?? vault} />;
}
