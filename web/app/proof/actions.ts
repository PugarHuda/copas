"use server";
import { walletSnapshot } from "@/lib/perpl/analytics";
import { leaderBookLive } from "@/lib/copas/data";
import { isAddress } from "@/lib/format";

/**
 * Live equity for the recompute box. A Copas LeaderBook is read on the Copas chain (equity, unitPrice, peakUnitPrice);
 * anything else is a Perpl mainnet wallet or account id: balanceCNS + Σ(depositCNS + pnlCNS).
 */
export async function liveEquity(q: string) {
  const s = q.trim();
  if (!isAddress(s) && !/^\d{1,9}$/.test(s)) return { error: "bad-input" as const };
  try {
    const book = isAddress(s) ? await leaderBookLive(s as `0x${string}`) : null;
    if (book) return { kind: "book" as const, ...book };
    const a = await walletSnapshot(s);
    if (!a) return { error: "not-found" as const };
    return { kind: "wallet" as const, equity: a.equity, valid: a.equityValid, accountId: a.accountId, balance: a.balance, positions: a.positions.length };
  } catch {
    return { error: "rpc" as const }; // unknown accounts are already null (lib/perpl/onchain noAccount)
  }
}
