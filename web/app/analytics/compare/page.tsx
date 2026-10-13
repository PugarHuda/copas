import Link from "next/link";
import type { Metadata } from "next";
import { Panel, Source, Empty } from "@/components/ui";
import { TimeChart } from "@/components/TimeChart";
import { walletEquityCurve, walletPeriods, walletSnapshot, walletTrades } from "@/lib/perpl/analytics";
import { isAddress, num, pct, short, usd } from "@/lib/format";
import { getT } from "@/lib/i18n/server";
import { WalletSearch } from "../_c/client";

export const metadata: Metadata = { title: "Compare wallets" };
const COLORS = ["#3987e5", "#d95926", "#199e70"]; // fixed categorical order, max 3 (validated all-pairs)

export default async function Compare({ searchParams }: { searchParams: Promise<{ w?: string }> }) {
  const { lang } = await getT();
  const L = (a: string, b: string) => (lang === "id" ? a : b);
  const ws = [...new Set((await searchParams).w?.split(",").map((s) => s.trim().toLowerCase()) ?? [])].filter((s) => isAddress(s) || /^\d+$/.test(s)).slice(0, 3);
  const data = await Promise.all(
    ws.map(async (w) => {
      const snap = await walletSnapshot(w).catch(() => null);
      if (!snap) return { w, snap: null };
      const [periods, curve, trades] = await Promise.all([
        walletPeriods(snap.address),
        walletEquityCurve(snap.accountId).then((r) => r.pts).catch(() => []),
        walletTrades(snap.accountId).catch(() => null),
      ]);
      return { w, snap, periods, curve, stats: trades?.stats ?? null };
    }),
  );
  const ok = data.filter((d) => d.snap);
  const rows: [string, (d: (typeof ok)[number]) => React.ReactNode][] = [
    ["Equity", (d) => usd(d.snap!.equity)],
    [L("Posisi terbuka", "Open positions"), (d) => d.snap!.positions.length],
    [L("Leverage akun", "Account leverage"), (d) => (d.snap!.equity > 0 ? `${num(d.snap!.positions.reduce((a, p) => a + p.notional, 0) / d.snap!.equity, 2)}x` : "–")],
    ...(["week", "month", "all"] as const).map(
      (p) =>
        [
          `PnL ${p === "week" ? "7d" : p === "month" ? "30d" : L("semua", "all")}`,
          (d: (typeof ok)[number]) => {
            const r = d.periods!.find((x) => x.period === p);
            return <span className={(r?.pnl ?? 0) >= 0 ? "text-up" : "text-down"}>{usd(r?.pnl, { sign: true })}</span>;
          },
        ] as [string, (d: (typeof ok)[number]) => React.ReactNode],
    ),
    [L("ROI 30d", "ROI 30d"), (d) => pct(d.periods!.find((x) => x.period === "month")?.roi, 1, true)],
    [L("Volume 30d", "Volume 30d"), (d) => usd(d.periods!.find((x) => x.period === "month")?.volume, { compact: true })],
    [L("Win rate (jendela scan)", "Win rate (scan window)"), (d) => pct(d.stats?.winRate, 1)],
    ["Profit factor", (d) => (d.stats?.profitFactor == null ? "–" : Number.isFinite(d.stats.profitFactor) ? num(d.stats.profitFactor, 2) : "∞")],
    [L("Trade", "Trades"), (d) => d.stats?.trades ?? "–"],
  ];
  // USD change, not an index: equity / start blows up (×1000s) when an account starts the window near $0 and then deposits
  const change = ok
    .filter((d) => d.curve && d.curve.length > 1)
    .map((d) => ({
      name: short(d.snap!.address),
      kind: "line" as const,
      color: COLORS[ok.indexOf(d)],
      data: d.curve!.map((p) => ({ t: p.t, v: p.equity - d.curve![0].equity })),
    }));
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/analytics" className="text-sm text-ink-3 hover:text-ink-2">
            {L("Analitik Perpl", "Perpl analytics")}
          </Link>
          <h1 className="mt-1 font-cond text-3xl font-semibold">{L("Bandingkan wallet", "Compare wallets")}</h1>
        </div>
        <WalletSearch compact />
      </div>
      {ok.length < 2 ? (
        <Panel>
          <Empty>
            {L("Pilih 2 sampai 3 wallet dari daftar pantau di halaman analitik, atau tambahkan ", "Pick 2 to 3 wallets from the watchlist on the analytics page, or add ")}
            <code className="num">?w=0xA,0xB</code>
          </Empty>
        </Panel>
      ) : (
        <>
          <Panel pad={false} title={L("Berdampingan", "Side by side")} aside={<Source kind="live">onchain + /trading/leaderboard</Source>}>
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th />
                    {ok.map((d, i) => (
                      <th key={d.w} className="r">
                        <Link href={`/analytics/wallet/${d.snap!.address.toLowerCase()}`} className="num inline-flex items-center gap-1.5 text-ink hover:text-gold-2">
                          <i className="inline-block h-2 w-2 rounded-sm" style={{ background: COLORS[i] }} />
                          {short(d.snap!.address)}
                        </Link>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([label, f]) => (
                    <tr key={label}>
                      <td className="text-ink-2">{label}</td>
                      {ok.map((d) => (
                        <td key={d.w} className="r">
                          {f(d)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <Panel title={L("Perubahan equity 5 hari", "5-day equity change")}>
            {change.length ? <TimeChart ariaLabel="Equity change" height={260} format="usd" series={change} /> : <Empty>–</Empty>}
            <p className="mt-2 text-xs text-ink-3">{L("Equity dikurangi equity di awal jendela, dalam AUSD. Termasuk deposit dan penarikan.", "Equity minus equity at the start of the window, in AUSD. Deposits and withdrawals are included.")}</p>
          </Panel>
        </>
      )}
      {data.some((d) => !d.snap) && <p className="text-sm text-warn">{L("Sebagian wallet tidak punya akun Perpl dan dilewati.", "Some wallets have no Perpl account and were skipped.")}</p>}
    </div>
  );
}
