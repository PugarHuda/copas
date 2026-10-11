import Link from "next/link";
import type { Metadata } from "next";
import { Panel, Source, Stat, StatRow, Empty } from "@/components/ui";
import { DDMeter } from "@/components/copas";
import { getLeader } from "@/lib/copas/data";
import { mockDownBook } from "@/lib/mock/copas"; // MOCK until BreachMarket + Kuru market are live
import { getT } from "@/lib/i18n/server";
import { num, pct, usd } from "@/lib/format";

export const metadata: Metadata = { title: "DOWN market" };

export default async function MarketPage({ params }: { params: Promise<{ leader: string }> }) {
  const { leader } = await params;
  const { t, lang } = await getT();
  const L = (a: string, b: string) => (lang === "id" ? a : b);
  const { leader: l } = await getLeader(leader);
  if (!l) return <Empty>{L("Leader tidak ditemukan.", "Leader not found.")}</Empty>;
  const b = mockDownBook(l);
  return (
    <div className="space-y-6">
      <div>
        <Link href={`/leader/${l.book}`} className="text-sm text-ink-3 hover:text-ink-2">
          {l.name}
        </Link>
        <h1 className="mt-1 font-cond text-3xl font-semibold">
          DOWN · {l.name} · epoch {b.epoch}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-ink-2">
          {L(
            "Setor 1 AUSD, dapat 1 UP + 1 DOWN. Di akhir epoch, DOWN bernilai 1 AUSD bila leader melanggar mandat, UP bernilai 1 AUSD bila tidak. Harga DOWN = peluang breach menurut pasar.",
            "Deposit 1 AUSD, get 1 UP + 1 DOWN. At epoch end, DOWN pays 1 AUSD if the leader broke the mandate, UP pays 1 AUSD if not. DOWN's price is the market's breach probability.",
          )}
        </p>
      </div>
      <Panel aside={<Source kind="mock">{t("common.mockNote")}</Source>} title={L("Pasar", "Market")}>
        <StatRow>
          <Stat label={L("Peluang breach (harga DOWN)", "Breach odds (DOWN price)")} value={pct(b.downPrice * 100, 0)} tone={b.downPrice > 0.5 ? "text-down" : ""} />
          <Stat label={L("Harga UP", "UP price")} value={num(b.upPrice, 2)} />
          <Stat label={L("Pasangan beredar", "Pairs outstanding")} value={num(b.supply, 0)} />
          <Stat label={L("Drawdown live / janji", "Drawdown live / declared")} value={<DDMeter live={l.liveDD} max={l.maxDD} />} />
        </StatRow>
      </Panel>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={L("Order book DOWN/AUSD (Kuru)", "DOWN/AUSD order book (Kuru)")} pad={false}>
          <table className="data">
            <thead>
              <tr>
                <th>{L("Harga", "Price")}</th>
                <th className="r">{L("Ukuran", "Size")}</th>
              </tr>
            </thead>
            <tbody>
              {[...b.asks].reverse().map((a) => (
                <tr key={"a" + a.px}>
                  <td className="text-down">{num(a.px, 2)}</td>
                  <td className="r">{num(a.size, 0)}</td>
                </tr>
              ))}
              {b.bids.map((x) => (
                <tr key={"b" + x.px}>
                  <td className="text-up">{num(x.px, 2)}</td>
                  <td className="r">{num(x.size, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title={L("Mint dan tebus", "Mint and redeem")}>
          <ul className="space-y-2 text-sm text-ink-2">
            <li>{L("Mint pasangan", "Mint a pair")}: <code className="num">BreachMarket.mint(leader, epoch, amount, to)</code></li>
            <li>{L("Tebus pasangan kapan saja", "Redeem a pair any time")}: <code className="num">redeemPair</code></li>
            <li>{L("Setelah settle, tebus sisi pemenang", "After settle, redeem the winning side")}: <code className="num">settle</code> → <code className="num">redeem</code></li>
          </ul>
          <p className="mt-3 text-xs text-ink-3">{L(`Mainnet: hanya mint/tebus (listing Kuru mainnet permissioned). Testnet: DOWN diperdagangkan di Kuru. Biaya 1 pasangan = ${usd(1)}.`, `Mainnet: mint/redeem only (Kuru mainnet listing is permissioned). Testnet: DOWN trades on Kuru. One pair costs ${usd(1)}.`)}</p>
        </Panel>
      </div>
    </div>
  );
}
