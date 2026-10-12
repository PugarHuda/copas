"use client";
import { useState } from "react";
import { erc20Abi, type Abi } from "viem";
import { toAusd } from "@/lib/format";
import { useL } from "@/lib/i18n/client";
import { useMeraSession } from "@/lib/mera/MeraProvider";
import { useCopasWrite } from "@/lib/copas/useCopasWrite";
import { copasAbi, deployment } from "@/lib/copas/contracts";
import { btn } from "@/components/ui";

/** Mint an UP+DOWN pair for 1 AUSD each, or redeem a full pair back, on BreachMarket. */
export function MintRedeem({ book, epoch, settled }: { book: `0x${string}`; epoch: number; settled: boolean }) {
  const L = useL();
  const { status, address } = useMeraSession();
  const { write, pending, error } = useCopasWrite();
  const [amt, setAmt] = useState("1");
  const [done, setDone] = useState<string>();
  const n = amt.trim() === "" ? NaN : Number(amt);
  const bad = !(n > 0);
  if (!deployment?.breachMarket || !deployment.ausd) return null;
  const bm = { address: deployment.breachMarket, abi: copasAbi.BreachMarket as Abi };
  const units = () => toAusd(n);

  async function mint() {
    setDone(undefined);
    const a = units();
    if (!(await write("small", { address: deployment!.ausd!, abi: erc20Abi as Abi, functionName: "approve", args: [deployment!.breachMarket!, a] }))) return;
    if (await write("small", { ...bm, functionName: "mint", args: [book, BigInt(epoch), a, address] })) setDone(L(`${n} pasangan dicetak.`, `${n} pair(s) minted.`));
  }
  async function redeem() {
    setDone(undefined);
    if (await write("small", { ...bm, functionName: "redeemPair", args: [book, BigInt(epoch), units()] })) setDone(L(`${n} pasangan ditebus.`, `${n} pair(s) redeemed.`));
  }

  if (status !== "signed-in") return <p className="text-sm text-ink-3">{L("Masuk dengan passkey untuk mint atau tebus pasangan.", "Sign in with your passkey to mint or redeem pairs.")}</p>;
  return (
    <div className="space-y-2">
      <label htmlFor="pairs" className="text-sm text-ink-2">
        {L(`Pasangan untuk epoch ${epoch} (1 AUSD per pasangan)`, `Pairs for epoch ${epoch} (1 AUSD each)`)}
      </label>
      <input
        id="pairs"
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        value={amt}
        onChange={(e) => setAmt(e.target.value)}
        aria-invalid={bad}
        className="num w-full rounded-md border border-line-strong bg-bg px-3 py-2 text-sm focus:border-gold focus:outline-none"
      />
      <div className="flex flex-wrap gap-2">
        <button className={btn.primary} disabled={pending || bad || settled} onClick={mint}>
          {L("Mint pasangan", "Mint pair")}
        </button>
        <button className={btn.ghost} disabled={pending || bad || settled} onClick={redeem}>
          {L("Tebus pasangan", "Redeem pair")}
        </button>
      </div>
      {settled && <p className="text-xs text-ink-3">{L("Seri ini sudah settle: tebus sisi pemenang.", "This series has settled: redeem the winning side.")}</p>}
      {done && <p role="status" className="text-xs text-up">{done}</p>}
      {error && <p role="alert" className="text-xs text-down">{error}</p>}
    </div>
  );
}
