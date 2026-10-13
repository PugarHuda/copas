import { isAddress } from "viem";
import { copasVault } from "@/lib/copas/indexer";
import { getLeader, recentSynced, vaultState } from "@/lib/copas/data";
import type { Metadata } from "next";
import { MeView } from "./MeView";

export const metadata: Metadata = { title: "My vault" };

type SP = Promise<{ owner?: string; vault?: string }>;

/** The connected wallet is client-only, so MeView pushes it into ?owner=. State is read from chain, history from the indexer (RPC logs as fallback). */
export default async function MePage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const query = sp.owner ?? sp.vault;
  // a malformed ?owner= / ?vault= reads nothing; MeView says the address is invalid
  const ok = (a?: string) => (a && isAddress(a, { strict: false }) ? a : undefined);
  const owner = ok(sp.owner), vault = ok(sp.vault);
  const live = await copasVault({ owner, vault });
  const chain = await vaultState({ owner, vault: live?.vault ?? vault });
  const [leader, rpcFills] = await Promise.all([
    chain?.leader ? getLeader(chain.leader).then((l) => l ?? null) : null,
    chain && !live?.fills.length ? recentSynced(chain.vault).catch(() => []) : [],
  ]);
  const fills = live?.fills.length ? { rows: live.fills, src: "indexer" as const } : { rows: rpcFills, src: "rpc" as const };
  return <MeView live={live} chain={chain} leader={leader} fills={fills} query={query} badQuery={!!query && !(owner ?? vault)} />;
}
