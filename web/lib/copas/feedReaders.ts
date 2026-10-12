"use server";
import { envioQuery, indexerConfigured } from "../perpl/indexer";

/** Owners of vaults actively following `book` (Envio). Empty when the indexer is off or has no rows. */
export async function followerOwners(book: string): Promise<string[]> {
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
