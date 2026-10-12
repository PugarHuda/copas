import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Panel, Source, Stat, StatRow } from "@/components/ui";
import { DDMeter } from "@/components/copas";
import { getDownMarket, getLeader } from "@/lib/copas/data";
import { getT } from "@/lib/i18n/server";
import { num, pct, usd } from "@/lib/format";
import { copasChain, explorerAddr, explorerTx, rpcTransport } from "@/lib/chains";
import { readDepth, readFills } from "@/lib/copas/kuru";
import { createPublicClient } from "viem";
import { MintRedeem } from "./MintRedeem";
import { KuruTrade } from "./KuruTrade";

const kuruClient = createPublicClient({ chain: copasChain, transport: rpcTransport(copasChain) });

export const metadata: Metadata = { title: "DOWN market" };

export default async function MarketPage({ params }: { params: Promise<{ leader: string }> }) {
  const { leader } = await params;
  const { lang } = await getT();
  const L = (a: string, b: string) => (lang === "id" ? a : b);
  const l = await getLeader(leader);
  if (!l) notFound();
  const live = await getDownMarket(l.book, l.epoch).catch(() => null);
  // no px until DOWN trades on Kuru: odds are shown only when there is a book
  const px = live && (live.bid && live.ask ? (live.bid + live.ask) / 2 : live.ask || live.bid);
  const b = {
    epoch: live?.epoch ?? l.epoch,
    downPrice: px || null,
    supply: live?.supply ?? 0,
    ask: live?.ask || null,
    bid: live?.bid || null,
  };
  const [depth, fills] = live?.market
    ? await Promise.all([readDepth(kuruClient, live.market).catch(() => null), readFills(live.market, copasChain.id).catch(() => null)])
    : [null, null];
  // asks shown high to low so the spread sits in the middle of the table
  const rows = depth ? [...depth.asks.slice(0, 8).reverse().map((x, i, a) => ({ ...x, side: "ask" as const, best: i === a.length - 1 })), ...depth.bids.slice(0, 8).map((x, i) => ({ ...x, side: "bid" as const, best: i === 0 }))] : [];
  return (
    <div className="space-y-6">
      <div>
        <Link href={`/leader/${l.book}`} className="text-sm text-ink-3 hover:text-ink-2">
          {l.name}
        </Link>
        <h1 className="mt-1 break-words font-cond text-3xl font-semibold">
          DOWN · {l.name} · epoch {b.epoch}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-2">
          {L(
            "Setor 1 AUSD, dapat 1 UP + 1 DOWN. Di akhir epoch, DOWN bernilai 1 AUSD bila leader melanggar mandat, UP bernilai 1 AUSD bila tidak. Harga DOWN = peluang breach menurut pasar.",
            "Deposit 1 AUSD, get 1 UP + 1 DOWN. At epoch end, DOWN pays 1 AUSD if the leader broke the mandate, UP pays 1 AUSD if not. DOWN's price is the market's breach probability.",
          )}
        </p>
      </div>
      <Panel aside={<Source kind="live">BreachMarket · Kuru</Source>} title={L("Pasar", "Market")}>
        <StatRow>
          <Stat label={L("Peluang breach (harga DOWN)", "Breach odds (DOWN price)")} value={b.downPrice != null ? pct(b.downPrice * 100, 0) : "–"} tone={(b.downPrice ?? 0) > 0.5 ? "text-down" : ""} sub={b.downPrice == null ? L("belum ada order di Kuru", "no Kuru orders yet") : undefined} />
          <Stat label={L("Harga UP", "UP price")} value={b.downPrice != null ? num(1 - b.downPrice, 2) : "–"} />
          <Stat label={L("Pasangan beredar", "Pairs outstanding")} value={num(b.supply, 0)} />
          <Stat label={L("Drawdown live / janji", "Drawdown live / declared")} value={<DDMeter live={l.liveDD} max={l.maxDD} />} />
        </StatRow>
      </Panel>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title={L("Order book DOWN/AUSD (Kuru)", "DOWN/AUSD order book (Kuru)")}
          pad={false}
          aside={live?.market ? <a className="text-xs underline" href={explorerAddr(live.market, copasChain.id)} target="_blank" rel="noreferrer">{live.market.slice(0, 10)}…</a> : undefined}
        >
          <table className="data">
            <thead>
              <tr>
                <th>{L("Sisi", "Side")}</th>
                <th className="r">{L("Harga (AUSD)", "Price (AUSD)")}</th>
                <th className="r">{L("Ukuran (DOWN)", "Size (DOWN)")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className={r.side === "ask" ? "text-down" : "text-up"}>{r.best ? (r.side === "ask" ? L("Ask terbaik", "Best ask") : L("Bid terbaik", "Best bid")) : r.side === "ask" ? "Ask" : "Bid"}</td>
                  <td className="r">{num(r.price, 3)}</td>
                  <td className="r">{num(r.size, 2)}</td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td colSpan={3} className="text-center text-ink-3">
                    {live ? L("Belum ada order di Kuru.", "No Kuru orders yet.") : L("Belum ada seri UP/DOWN yang dicetak untuk epoch ini.", "No UP/DOWN series minted for this epoch yet.")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          {depth && <p className="px-4 py-3 text-xs text-ink-3">{L(`Kedalaman L2 dari OrderBook.getL2Book Kuru, blok ${depth.block}.`, `L2 depth from Kuru OrderBook.getL2Book, block ${depth.block}.`)}</p>}
        </Panel>
        <Panel title={L("Mint dan tebus", "Mint and redeem")}>
          <MintRedeem book={l.book} epoch={b.epoch} settled={!!live?.settled} />
          <p className="mt-3 text-xs text-ink-3">
            {L("Mint menyetor AUSD dan mencetak 1 UP + 1 DOWN per AUSD. Pasangan penuh bisa ditebus 1:1 sebelum settle; setelah settle, tebus sisi pemenang.", "Minting deposits AUSD and creates 1 UP + 1 DOWN per AUSD. A full pair redeems 1:1 before settlement; after it, redeem the winning side.")}
          </p>
          <p className="mt-3 text-xs text-ink-3">{L(`Mainnet: hanya mint/tebus (listing Kuru mainnet permissioned). Testnet: DOWN diperdagangkan di Kuru. Biaya 1 pasangan = ${usd(1)}.`, `Mainnet: mint/redeem only (Kuru mainnet listing is permissioned). Testnet: DOWN trades on Kuru. One pair costs ${usd(1)}.`)}</p>
        </Panel>
      </div>
      {live?.market && depth && !live.settled && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel title={L("Trading DOWN di Kuru", "Trade DOWN on Kuru")} aside={<Source kind="live">Kuru OrderBook</Source>}>
            <KuruTrade market={live.market} down={live.down} depth={depth} chainId={copasChain.id} />
            <p className="mt-3 text-xs text-ink-3">
              {L(
                "Order market IOC langsung dari wallet passkey (approve lalu placeAndExecuteMarketBuy/Sell). Beli DOWN = lindung nilai bila leader melanggar; jual DOWN hasil mint = taruhan leader menepati mandat.",
                "IOC market order straight from your passkey wallet (approve, then placeAndExecuteMarketBuy/Sell). Buying DOWN hedges a breach; selling minted DOWN bets the leader keeps the mandate.",
              )}
            </p>
          </Panel>
          {fills && (
            <Panel title={L("Fill terakhir (Kuru)", "Recent fills (Kuru)")} pad={false} aside={<Source kind="live">Envio HyperSync</Source>}>
              <table className="data">
                <thead>
                  <tr>
                    <th>{L("Taker", "Taker")}</th>
                    <th className="r">{L("Harga", "Price")}</th>
                    <th className="r">DOWN</th>
                    <th className="r">Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {fills.map((f) => (
                    <tr key={f.tx + f.size}>
                      <td className={f.takerSide === "buy" ? "text-up" : "text-down"}>
                        {f.takerSide === "buy" ? L("beli", "buy") : L("jual", "sell")}
                        {f.maker.toLowerCase() === f.taker.toLowerCase() && <span className="ml-1 text-ink-3">({L("market maker sendiri", "market maker self-fill")})</span>}
                      </td>
                      <td className="r">{num(f.price, 3)}</td>
                      <td className="r">{num(f.size, 2)}</td>
                      <td className="r">
                        <a className="underline" href={explorerTx(f.tx, copasChain.id)} target="_blank" rel="noreferrer">
                          {f.tx.slice(0, 8)}…
                        </a>
                      </td>
                    </tr>
                  ))}
                  {!fills.length && (
                    <tr>
                      <td colSpan={4} className="text-center text-ink-3">{L("Belum ada fill di book ini.", "No fills on this book yet.")}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Panel>
          )}
        </div>
      )}
    </div>
  );
}
