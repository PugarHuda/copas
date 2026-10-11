"use server";
import { walletSnapshot } from "@/lib/perpl/analytics";
import { isAddress } from "@/lib/format";

/** Live Perpl equity for an address or account id: balanceCNS + Σ(depositCNS + pnlCNS). */
export async function liveEquity(q: string) {
  const s = q.trim();
  if (!isAddress(s) && !/^\d{1,9}$/.test(s)) return { error: "bad-input" as const };
  try {
    const a = await walletSnapshot(s);
    if (!a) return { error: "not-found" as const };
    return { equity: a.equity, valid: a.equityValid, accountId: a.accountId, balance: a.balance, positions: a.positions.length };
  } catch {
    return { error: "rpc" as const };
  }
}
