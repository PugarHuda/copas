"use client";
import { useState } from "react";
import { erc20Abi, parseUnits, type Abi } from "viem";
import { useRouter } from "next/navigation";
import { useL } from "@/lib/i18n/client";
import { useMeraSession } from "@/lib/mera/MeraProvider";
import { useCopasWrite } from "@/lib/copas/useCopasWrite";
import { deployment } from "@/lib/copas/contracts";
import { KURU, kuruBookAbi, walkBook, type Depth } from "@/lib/copas/kuru";
import { explorerTx } from "@/lib/chains";
import { btn } from "@/components/ui";

const SLIPPAGE = 0.02; // minOut = 98% of the book-walk estimate; the order reverts if the book moved further

/** IOC market order on the Kuru DOWN/AUSD book, paid from the passkey wallet (isMargin=false: approve, then trade). */
export function KuruTrade({ market, down, depth, chainId }: { market: `0x${string}`; down: `0x${string}`; depth: Depth; chainId: number }) {
  const L = useL();
  const router = useRouter();
  const { status } = useMeraSession();
  const { write, pending, error } = useCopasWrite();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("1");
  const [done, setDone] = useState<string>();
  const n = amt.trim() === "" ? NaN : Number(amt);
  const q = n > 0 ? walkBook(depth, side, n) : undefined;
  const thin = !!q && q.filled + 1e-9 < n;
  const bad = !q || q.out <= 0 || thin;
  if (!deployment?.ausd) return null;
  const inSym = side === "buy" ? "AUSD" : "DOWN";
  const outSym = side === "buy" ? "DOWN" : "AUSD";

  async function trade() {
    if (!q) return;
    setDone(undefined);
    const tokenIn = side === "buy" ? deployment!.ausd! : down;
    if (!(await write("small", { address: tokenIn, abi: erc20Abi as Abi, functionName: "approve", args: [market, parseUnits(n.toFixed(6), 6)] }))) return;
    const minOut = parseUnits((q.out * (1 - SLIPPAGE)).toFixed(6), 6);
    const h = await write("small", {
      address: market,
      abi: kuruBookAbi as Abi,
      functionName: side === "buy" ? "placeAndExecuteMarketBuy" : "placeAndExecuteMarketSell",
      // buy: quote size in price precision (AUSD × 1e4); sell: base size in size precision (DOWN × 1e2)
      args: side === "buy" ? [BigInt(Math.floor(n * KURU.pricePrecision)), minOut, false, false] : [BigInt(Math.floor(n * KURU.sizePrecision)), minOut, false, false],
    });
    if (h) {
      setDone(h);
      router.refresh();
    }
  }

  if (status !== "signed-in") return <p className="text-sm text-ink-3">{L("Masuk dengan passkey untuk trading DOWN di Kuru.", "Sign in with your passkey to trade DOWN on Kuru.")}</p>;
  return (
    <div className="space-y-2">
      <div className="flex gap-2" role="radiogroup" aria-label={L("Sisi", "Side")}>
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} role="radio" aria-checked={side === s} className={side === s ? btn.primary : btn.ghost} onClick={() => setSide(s)}>
            {s === "buy" ? L("Beli DOWN", "Buy DOWN") : L("Jual DOWN", "Sell DOWN")}
          </button>
        ))}
      </div>
      <label htmlFor="kuru-amt" className="text-sm text-ink-2">
        {side === "buy" ? L("AUSD yang dibelanjakan", "AUSD to spend") : L("DOWN yang dijual", "DOWN to sell")}
      </label>
      <input
        id="kuru-amt"
        type="number"
        inputMode="decimal"
        min={0}
        step="any"
        value={amt}
        onChange={(e) => setAmt(e.target.value)}
        aria-invalid={bad}
        className="num w-full rounded-md border border-line-strong bg-bg px-3 py-2 text-sm focus:border-gold focus:outline-none"
      />
      {q && (
        <p className="text-xs text-ink-2">
          {thin
            ? L(`Book terlalu tipis: hanya ${q.filled.toFixed(2)} ${inSym} yang bisa terisi.`, `Book too thin: only ${q.filled.toFixed(2)} ${inSym} can fill.`)
            : L(
                `Perkiraan ${q.out.toFixed(4)} ${outSym} (rata-rata ${q.avgPrice.toFixed(4)} AUSD, fee taker ${KURU.takerFeeBps / 100}%), minimum ${(q.out * (1 - SLIPPAGE)).toFixed(4)}.`,
                `About ${q.out.toFixed(4)} ${outSym} (avg ${q.avgPrice.toFixed(4)} AUSD, taker fee ${KURU.takerFeeBps / 100}%), minimum ${(q.out * (1 - SLIPPAGE)).toFixed(4)}.`,
              )}
        </p>
      )}
      <button className={btn.primary} disabled={pending || bad} onClick={trade}>
        {pending ? L("Mengirim…", "Sending…") : side === "buy" ? L("Beli DOWN di Kuru", "Buy DOWN on Kuru") : L("Jual DOWN di Kuru", "Sell DOWN on Kuru")}
      </button>
      {done && (
        <p role="status" className="text-xs text-up">
          {L("Terisi. ", "Filled. ")}
          <a className="underline" href={explorerTx(done, chainId)} target="_blank" rel="noreferrer">
            {done.slice(0, 10)}…
          </a>
        </p>
      )}
      {error && <p role="alert" className="text-xs text-down">{error}</p>}
    </div>
  );
}
