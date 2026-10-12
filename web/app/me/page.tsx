import { copasVault } from "@/lib/copas/indexer";
import { MeView } from "./MeView";

type SP = Promise<{ owner?: string; vault?: string }>;

/** The connected wallet is client-only, so MeView pushes it into ?owner= and the vault is read here from the indexer. */
export default async function MePage({ searchParams }: { searchParams: SP }) {
  const { owner, vault } = await searchParams;
  return <MeView live={await copasVault({ owner, vault })} query={owner ?? vault} />;
}
