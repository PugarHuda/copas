import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Panel, Source, Stat, StatRow, Empty, Bar } from "@/components/ui";
import { TimeChart } from "@/components/TimeChart";
import { FLOW_DAYS, walletEquityCurve, walletFlows, walletPeriods, walletSnapshot, walletTrades } from "@/lib/perpl/analytics";
import type { AccountSnapshot } from "@/lib/perpl/onchain";
import type { TradeStats } from "@/lib/perpl/stats";
import { ago, isAddress, num, pct, price, short, usd } from "@/lib/format";
import { explorerAddr, explorerTx } from "@/lib/chains";
import { getT } from "@/lib/i18n/server";
import { indexerFresh } from "@/lib/perpl/indexer";
import { WalletSearch, WatchButton } from "../../_c/client";

type P = Promise<{ addr: string }>;
type Lx = (a: string, b: string) => string;
const isAccountId = (s: string) => /^\d{1,9}$/.test(s);

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const { addr } = await params;
  return { title: isAddress(addr) ? `Wallet ${short(addr)}` : isAccountId(addr) ? `Account #${addr}` : "Not found" };
}

export default async function WalletPage({ params }: { params: P }) {
  const { addr } = await params;
  if (!isAddress(addr) && !isAccountId(addr)) notFound();
  const { lang } = await getT();
  const L: Lx = (a, b) => (lang === "id" ? a : b);

  const snap = await walletSnapshot(addr.toLowerCase()).catch(() => undefined);
  if (snap === undefined) return <Empty>{L("RPC Monad tidak merespons. Muat ulang sebentar lagi.", "The Monad RPC did not respond. Reload in a moment.")}</Empty>;
  if (!snap)
    return (
      <div className="space-y-6">
        <Link href="/analytics" className="text-sm text-ink-3 hover:text-ink-2">
          {L("Kembali ke analitik Perpl", "Back to Perpl analytics")}
        </Link>
        <Panel>
          <Empty>{isAccountId(addr) ? L(`Akun #${addr} tidak ditemukan di Perpl.`, `Account #${addr} not found on Perpl.`) : L("Wallet ini belum punya akun exchange Perpl.", "This wallet has no Perpl exchange account.")}</Empty>
          <div className="flex justify-center pb-4">
            <WalletSearch compact />
          </div>
        </Panel>
      </div>
    );

  const address = snap.address.toLowerCase();
  const idx = await indexerFresh();
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link href="/analytics" className="text-sm text-ink-3 hover:text-ink-2">
            {L("Analitik Perpl", "Perpl analytics")}
          </Link>
          <h1 className="num mt-1 break-all font-cond text-2xl font-semibold sm:text-3xl">{short(address)}</h1>
          <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-ink-3">
            <span className="num break-all">{address}</span>
            <span>
              {L("Akun", "Account")} #{snap.accountId}
            </span>
            <a href={explorerAddr(address)} target="_blank" rel="noreferrer" className="hover:text-ink-2">
              MonadScan
            </a>
            {snap.frozen && <span className="text-warn">{L("Akun dibekukan", "Account frozen")}</span>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <WatchButton address={address} />
          <Link className="rounded-md border border-line-strong px-4 py-1.5 text-sm hover:bg-surface-2" href={`/analytics/compare?w=${address}`}>
            {L("Bandingkan", "Compare")}
          </Link>
          <WalletSearch compact />
        </div>
      </div>

      <Overview snap={snap} L={L} />

      <Panel title={L("Posisi terbuka", "Open positions")} aside={<Source kind="live">getPosition</Source>} pad={false}>
        <Positions snap={snap} L={L} />
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={L("Kinerja per periode", "Performance by period")} aside={<Source kind="live">/trading/leaderboard</Source>} pad={false}>
          <Suspense fallback={<Sk h={220} />}>
            <Periods address={address} L={L} />
          </Suspense>
        </Panel>
        <Panel
          title={idx ? L("Kurva equity terealisasi, seluruh histori", "Realized equity curve, full history") : L("Kurva equity, 5 hari", "Equity curve, 5 days")}
          aside={idx ? <Source kind="indexer">AccountDaily + CollateralFlow</Source> : <Source kind="rpc">{L("State historis", "Historical state")}</Source>}
        >
          <Suspense fallback={<Sk h={220} />}>
            <Equity accountId={snap.accountId} L={L} />
          </Suspense>
        </Panel>
      </div>

      <Suspense fallback={<Panel title={L("Analitik trade", "Trade analytics")}><Sk h={300} /></Panel>}>
        <Trades accountId={snap.accountId} snap={snap} L={L} />
      </Suspense>

      <Panel
        title={idx ? L("Deposit dan penarikan, seluruh histori", "Deposits and withdrawals, full history") : L(`Deposit dan penarikan, ${FLOW_DAYS} hari`, `Deposits and withdrawals, ${FLOW_DAYS} days`)}
        pad={false}
        aside={idx ? <Source kind="indexer">CollateralFlow</Source> : <Source kind="rpc">CollateralDeposit / Withdrawal</Source>}
      >
        <Suspense fallback={<Sk h={120} />}>
          <Flows accountId={snap.accountId} L={L} />
        </Suspense>
      </Panel>
    </div>
  );
}

function Sk({ h }: { h: number }) {
  return <div className="animate-pulse rounded bg-surface-2/60" style={{ height: h }} aria-hidden />;
}

function Overview({ snap, L }: { snap: AccountSnapshot; L: Lx }) {
  const margin = snap.positions.reduce((a, p) => a + p.margin, 0);
  const upnl = snap.positions.reduce((a, p) => a + p.upnl, 0);
  const notional = snap.positions.reduce((a, p) => a + p.notional, 0);
  const total = Math.max(1e-9, snap.balance + margin + Math.max(0, upnl));
  return (
    <Panel title={L("Portofolio dan margin", "Portfolio and margin")} aside={<Source kind="live">{snap.equityValid ? L("Equity valid", "Equity valid") : L("Mark price tidak valid", "Mark price invalid")}</Source>}>
      <StatRow>
        <Stat label="Equity" value={usd(snap.equity)} />
        <Stat label={L("Saldo bebas", "Free balance")} value={usd(snap.balance)} sub={snap.locked ? `${L("terkunci order", "locked in orders")} ${usd(snap.locked)}` : undefined} />
        <Stat label={L("Margin di posisi", "Margin in positions")} value={usd(margin)} />
        <Stat label="uPnL" value={usd(upnl, { sign: true })} tone={upnl >= 0 ? "text-up" : "text-down"} />
        <Stat label={L("Exposure", "Exposure")} value={usd(notional, { compact: true })} />
        <Stat label={L("Leverage akun", "Account leverage")} value={snap.equity > 0 ? `${num(notional / snap.equity, 2)}x` : "–"} />
      </StatRow>
      <div className="mt-5">
        <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-sm" aria-hidden>
          <div className="bg-[var(--c1)]" style={{ width: `${(snap.balance / total) * 100}%` }} />
          <div className="bg-gold" style={{ width: `${(margin / total) * 100}%` }} />
          {upnl > 0 && <div className="bg-up" style={{ width: `${(upnl / total) * 100}%` }} />}
        </div>
        <div className="mt-2 flex flex-wrap gap-4 text-xs text-ink-3">
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-sm bg-[var(--c1)]" />{L("Saldo bebas", "Free balance")}</span>
          <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-sm bg-gold" />{L("Margin posisi", "Position margin")}</span>
          {upnl > 0 && <span className="inline-flex items-center gap-1.5"><i className="inline-block h-2 w-2 rounded-sm bg-up" />{L("Profit belum terealisasi", "Unrealized profit")}</span>}
        </div>
      </div>
    </Panel>
  );
}

function Positions({ snap, L }: { snap: AccountSnapshot; L: Lx }) {
  if (!snap.positions.length) return <Empty>{L("Tidak ada posisi terbuka.", "No open positions.")}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="data">
        <thead>
          <tr>
            <th>Market</th>
            <th>{L("Arah", "Side")}</th>
            <th className="r">{L("Ukuran", "Size")}</th>
            <th className="r">Notional</th>
            <th className="r">{L("Harga masuk", "Entry")}</th>
            <th className="r">Mark</th>
            <th className="r">Lev.</th>
            <th className="r">Margin</th>
            <th className="r">uPnL</th>
            <th className="r">Funding</th>
            <th className="r">{L("Likuidasi (est.)", "Liq. (est.)")}</th>
          </tr>
        </thead>
        <tbody>
          {snap.positions.map((p) => (
            <tr key={p.marketId}>
              <td className="font-medium">{p.market}</td>
              <td className={p.side === "long" ? "text-up" : "text-down"}>{p.side === "long" ? "Long" : "Short"}</td>
              <td className="r">{num(p.size, 4)}</td>
              <td className="r">{usd(p.notional)}</td>
              <td className="r">{price(p.entry)}</td>
              <td className="r">{price(p.mark)}</td>
              <td className="r">{Number.isFinite(p.leverage) ? `${num(p.leverage, 1)}x` : "–"}</td>
              <td className="r">{usd(p.margin)}</td>
              <td className={`r ${p.upnl >= 0 ? "text-up" : "text-down"}`}>
                {usd(p.upnl, { sign: true })} <span className="text-ink-3">{pct((p.upnl / Math.max(1e-9, p.margin)) * 100, 1, true)}</span>
              </td>
              <td className={`r ${p.funding >= 0 ? "text-up" : "text-down"}`}>{usd(p.funding, { sign: true })}</td>
              <td className="r">
                {price(p.liq)} <span className={p.liqDistance != null && p.liqDistance < 5 ? "text-down" : "text-ink-3"}>{pct(p.liqDistance, 1)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function Periods({ address, L }: { address: string; L: Lx }) {
  const rows = await walletPeriods(address);
  const names: Record<string, string> = { day: "24h", week: "7d", "2weeks": "14d", month: "30d", all: L("Semua", "All") };
  return (
    <div className="overflow-x-auto">
    <table className="data">
      <thead>
        <tr>
          <th>{L("Periode", "Period")}</th>
          <th className="r">PnL</th>
          <th className="r">ROI</th>
          <th className="r">{L("Volume", "Volume")}</th>
          <th className="r">{L("Peringkat", "Rank")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.period}>
            <td>{names[r.period]}</td>
            <td className={`r ${(r.pnl ?? 0) >= 0 ? "text-up" : "text-down"}`}>{usd(r.pnl, { sign: true })}</td>
            <td className="r">{pct(r.roi, 1, true)}</td>
            <td className="r text-ink-2">{usd(r.volume, { compact: true })}</td>
            <td className="r text-ink-2">{r.rank ? `${r.rank.toLocaleString("en-US")} / ${r.of.toLocaleString("en-US")}` : "–"}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <p className="px-4 py-3 text-xs text-ink-3">
      {L(
        "PnL ini angka leaderboard Perpl sendiri (setelah fee, termasuk posisi terbuka). PnL terealisasi di analitik trade hanya trade tertutup, sebelum fee, jadi keduanya bisa berbeda.",
        "This is Perpl's own leaderboard PnL (after fees, including open positions). Realized PnL under trade analytics counts closed trades only, before fees, so the two can differ.",
      )}
    </p>
    </div>
  );
}

async function Equity({ accountId, L }: { accountId: number; L: Lx }) {
  const [eq, wf] = await Promise.all([walletEquityCurve(accountId).catch(() => null), walletFlows(accountId).catch(() => null)]);
  const pts = eq?.pts ?? [];
  const flows = wf?.rows ?? [];
  const envio = eq?.source === "envio";
  if (pts.length < 2) return <Empty>{L("Belum cukup histori.", "Not enough history yet.")}</Empty>;
  // Flow-adjusted: remove deposits/withdrawals made after the first sample, so a withdrawal is not a drawdown.
  const t0 = pts[0].t;
  const adj = pts.map((p) => p.equity - flows.filter((f) => f.t > t0 && f.t <= p.t).reduce((a, f) => a + f.amount, 0));
  // equity at or below zero after removing flows means the flow history is incomplete: no honest drawdown exists
  const broken = adj.some((v) => v <= 0);
  let peak = -Infinity;
  let dd = 0;
  for (const v of adj) {
    peak = Math.max(peak, v);
    if (peak > 0) dd = Math.max(dd, (peak - v) / peak);
  }
  const first = pts[0].equity;
  const last = pts[pts.length - 1].equity;
  return (
    <>
      <div className="mb-3 grid grid-cols-3 gap-4">
        <Stat label={envio ? L("Perubahan sejak awal", "Change since start") : L("Perubahan 5 hari", "5-day change")} value={usd(last - first, { sign: true, compact: true })} tone={last >= first ? "text-up" : "text-down"} />
        <Stat
          label={L("Drawdown maks (tanpa arus dana)", "Max drawdown (flow-adjusted)")}
          value={broken ? "–" : pct(dd * 100, 2)}
          tone={!broken && dd > 0.1 ? "text-down" : ""}
          sub={broken ? L("arus dana tidak lengkap", "flow history incomplete") : undefined}
        />
        <Stat label={L("Equity puncak", "Peak equity")} value={usd(Math.max(...pts.map((p) => p.equity)), { compact: true })} />
      </div>
      <TimeChart ariaLabel="Equity" height={180} series={[{ name: "Equity", kind: "area", color: "#3987e5", data: pts.map((p) => ({ t: p.t, v: p.equity })) }]} />
      <p className="mt-2 text-xs text-ink-3">
        {envio
          ? L("Equity terealisasi harian = deposit bersih + PnL terealisasi kumulatif − fee (tanpa PnL belum terealisasi). Deposit dan penarikan ikut menggeser kurva.", "Daily realized equity = net deposits + cumulative realized PnL − fees (excludes unrealized PnL). Deposits and withdrawals also move the curve.")
          : L("Equity = saldo + Σ(margin + PnL) di 41 blok historis. Deposit dan penarikan ikut menggeser kurva.", "Equity = balance + Σ(margin + PnL) at 41 historical blocks. Deposits and withdrawals also move the curve.")}
      </p>
    </>
  );
}

const hold = (ms: number | null) => (ms == null ? "–" : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : ms < 86_400_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${(ms / 86_400_000).toFixed(1)}d`);

async function Trades({ accountId, snap, L }: { accountId: number; snap: AccountSnapshot; L: Lx }) {
  const r = await walletTrades(accountId).catch(() => null);
  if (!r)
    return (
      <Panel title={L("Analitik trade", "Trade analytics")}>
        <Empty>{L("Histori trade gagal dimuat dari RPC. Muat ulang sebentar lagi.", "Trade history could not be loaded from the RPC. Reload in a moment.")}</Empty>
      </Panel>
    );
  const s = r.stats;
  const src =
    r.source === "envio"
      ? L("Indexer Envio, seluruh histori", "Envio indexer, full history")
      : L(`Scan log RPC, ${r.windowHours} jam terakhir`, `RPC log scan, last ${r.windowHours} hours`);
  return (
    <>
      <Panel title={L("Analitik trade", "Trade analytics")} aside={<Source kind={r.source === "envio" ? "indexer" : "rpc"}>{src}</Source>}>
        {s.trades === 0 ? (
          <Empty>{L("Tidak ada trade tertutup di jendela ini.", "No closed trades in this window.")}</Empty>
        ) : (
          <div className="grid gap-6 lg:grid-cols-3">
            <div className="grid grid-cols-2 content-start gap-x-6 gap-y-5 sm:grid-cols-3 lg:col-span-2">
              <Stat label={L("PnL terealisasi", "Realized PnL")} value={usd(s.realized, { sign: true })} tone={s.realized >= 0 ? "text-up" : "text-down"} sub={`${s.trades.toLocaleString("en-US")} trades · ${L("sebelum fee", "before fees")}`} />
              <Stat label="Win rate" value={pct(s.winRate, 1)} sub={`${s.wins}W / ${s.losses}L`} />
              <Stat label="Profit factor" value={s.profitFactor == null ? "–" : Number.isFinite(s.profitFactor) ? num(s.profitFactor, 2) : "∞"} />
              <Stat label={L("Drawdown maks (realized)", "Max drawdown (realized)")} value={usd(s.maxDrawdown)} tone={s.maxDrawdown > 0 ? "text-down" : ""} />
              <Stat label={L("Rata-rata menang / kalah", "Avg win / loss")} value={`${usd(s.avgWin, { compact: true })} / ${usd(s.avgLoss, { compact: true })}`} />
              <Stat label={L("Streak terpanjang", "Longest streak")} value={`${s.longestWinStreak}W / ${s.longestLossStreak}L`} />
              <Stat label={L("Rata-rata lama posisi", "Avg hold time")} value={hold(s.avgHoldMs)} />
              <Stat label={L("Long / short PnL", "Long / short PnL")} value={`${usd(s.longPnl, { compact: true, sign: true })} / ${usd(s.shortPnl, { compact: true, sign: true })}`} />
              <Stat label={L("Likuidasi", "Liquidations")} value={num(s.liquidations, 0)} tone={s.liquidations ? "text-down" : ""} />
            </div>
            <ByMarket s={s} L={L} />
            <div className="lg:col-span-3">
              <TimeChart ariaLabel={L("PnL terealisasi kumulatif", "Cumulative realized PnL")} height={180} series={[{ name: L("PnL terealisasi kumulatif", "Cumulative realized PnL"), kind: "line", color: "#3987e5", data: s.curve.map((p) => ({ t: p.t, v: p.cum })) }]} />
            </div>
          </div>
        )}
        <p className="mt-3 text-xs text-ink-3">
          {L(
            "Trade = buka posisi sampai tutup/likuidasi, PnL termasuk funding, sebelum fee trading. Tanpa indexer, histori dibatasi jendela scan RPC; set NEXT_PUBLIC_ENVIO_GRAPHQL_URL untuk seluruh histori.",
            "A trade runs from open to close/liquidation; PnL includes funding, before trading fees. Without the indexer, history is limited to the RPC scan window; set NEXT_PUBLIC_ENVIO_GRAPHQL_URL for full history.",
          )}
        </p>
      </Panel>
      <Insights s={s} snap={snap} L={L} />
      {s.trades > 0 && (
        <Panel title={L("Histori trade", "Trade history")} pad={false}>
          <div className="max-h-[420px] overflow-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>{L("Ditutup", "Closed")}</th>
                  <th>Market</th>
                  <th>{L("Arah", "Side")}</th>
                  <th className="r">{L("Masuk", "Entry")}</th>
                  <th className="r">{L("Keluar", "Exit")}</th>
                  <th className="r">{L("Notional maks", "Max notional")}</th>
                  <th className="r">{L("Lama", "Held")}</th>
                  <th className="r">PnL</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {r.trades.slice(0, 200).map((t, i) => (
                  <tr key={t.tx + i}>
                    <td className="text-ink-3">{t.closedAt ? ago(t.closedAt) : "–"}</td>
                    <td>{t.market}</td>
                    <td className={t.side === "long" ? "text-up" : "text-down"}>
                      {t.side === "long" ? "Long" : "Short"} {t.liquidated && <span className="text-down">({L("likuidasi", "liquidated")})</span>}
                    </td>
                    <td className="r">{price(t.entry)}</td>
                    <td className="r">{price(t.exit)}</td>
                    <td className="r">{t.maxNotional ? usd(t.maxNotional, { compact: true }) : "–"}</td>
                    <td className="r text-ink-2">{t.openedAt && t.closedAt ? hold(t.closedAt - t.openedAt) : "–"}</td>
                    <td className={`r ${t.pnl >= 0 ? "text-up" : "text-down"}`}>{usd(t.pnl, { sign: true })}</td>
                    <td className="r">
                      {t.tx && (
                        <a className="text-ink-3 hover:text-ink-2" href={explorerTx(t.tx)} target="_blank" rel="noreferrer">
                          tx
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </>
  );
}

function ByMarket({ s, L }: { s: TradeStats; L: Lx }) {
  const max = Math.max(...s.byMarket.map((m) => Math.abs(m.pnl)), 1);
  return (
    <div>
      <h3 className="mb-2 text-xs text-ink-3">{L("PnL per market, terbaik ke terburuk", "PnL by market, best to worst")}</h3>
      <ul className="space-y-2">
        {s.byMarket.map((m) => (
          <li key={m.market} className="grid grid-cols-[48px_1fr_96px] items-center gap-3 text-sm">
            <span>{m.market}</span>
            <Bar value={m.pnl} max={max} className={m.pnl >= 0 ? "bg-up" : "bg-down"} />
            <span className={`num text-right ${m.pnl >= 0 ? "text-up" : "text-down"}`}>{usd(m.pnl, { sign: true, compact: true })}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Deterministic, rule-based read of the numbers. The AI analyst (SPEC D1) will replace this text, not the numbers. */
function Insights({ s, snap, L }: { s: TradeStats; snap: AccountSnapshot; L: Lx }) {
  const out: { tone: "up" | "down" | "warn"; text: string }[] = [];
  const lev = snap.equity > 0 ? snap.positions.reduce((a, p) => a + p.notional, 0) / snap.equity : 0;
  const near = snap.positions.filter((p) => p.liqDistance != null && p.liqDistance < 5);
  if (near.length) out.push({ tone: "down", text: L(`${near.length} posisi berada kurang dari 5% dari harga likuidasi.`, `${near.length} position(s) sit within 5% of liquidation.`) });
  if (lev > 10) out.push({ tone: "warn", text: L(`Leverage akun ${lev.toFixed(1)}x. Pergerakan ${(100 / lev).toFixed(1)}% bisa menghapus equity.`, `Account leverage is ${lev.toFixed(1)}x. A ${(100 / lev).toFixed(1)}% move could wipe the equity.`) });
  if (s.trades >= 5 && s.profitFactor != null && s.profitFactor > 1.5) out.push({ tone: "up", text: L(`Profit factor ${s.profitFactor.toFixed(2)} dari ${s.trades} trade: kemenangan menutup kekalahan dengan nyaman.`, `Profit factor ${s.profitFactor.toFixed(2)} over ${s.trades} trades: wins comfortably cover losses.`) });
  if (s.trades >= 5 && s.winRate != null && s.winRate > 60 && s.avgLoss != null && s.avgWin != null && Math.abs(s.avgLoss) > 2 * s.avgWin)
    out.push({ tone: "warn", text: L("Win rate tinggi tapi kerugian rata-rata lebih dari 2x kemenangan: pola memegang posisi rugi terlalu lama.", "High win rate, but the average loss is over 2x the average win: a pattern of holding losers too long.") });
  if (s.longestLossStreak >= 4) out.push({ tone: "warn", text: L(`Pernah kalah ${s.longestLossStreak} kali beruntun. Cek apakah ukuran posisi naik setelah rugi.`, `Lost ${s.longestLossStreak} times in a row. Check whether size grew after losses.`) });
  if (s.liquidations) out.push({ tone: "down", text: L(`${s.liquidations} likuidasi di jendela ini.`, `${s.liquidations} liquidation(s) in this window.`) });
  const top = s.byMarket[0];
  if (top && s.byMarket.length > 1 && top.pnl > 0 && top.pnl > s.realized) out.push({ tone: "warn", text: L(`Semua profit bersih datang dari ${top.market}; market lain merugi.`, `All net profit comes from ${top.market}; other markets lose money.`) });
  if (!out.length) return null;
  return (
    <Panel title={L("Insight otomatis", "Automated insights")} aside={<span>{L("Berbasis aturan", "Rule-based")}</span>}>
      <ul className="space-y-2 text-sm">
        {out.map((o) => (
          <li key={o.text} className="flex gap-2">
            <span aria-hidden className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${o.tone === "up" ? "bg-up" : o.tone === "down" ? "bg-down" : "bg-warn"}`} />
            <span className="text-ink-2">{o.text}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

async function Flows({ accountId, L }: { accountId: number; L: Lx }) {
  const r = await walletFlows(accountId).catch(() => null);
  if (!r) return <Empty>{L("RPC log tidak tersedia.", "The log RPC is unavailable.")}</Empty>;
  const f = r.rows;
  if (!f.length)
    return <Empty>{r.source === "envio" ? L("Belum ada deposit atau penarikan yang terindeks.", "No indexed deposits or withdrawals yet.") : L(`Tidak ada deposit atau penarikan dalam ${FLOW_DAYS} hari.`, `No deposits or withdrawals in ${FLOW_DAYS} days.`)}</Empty>;
  const net = f.reduce((a, x) => a + x.amount, 0);
  return (
    <div>
      <p className="px-4 pt-3 text-sm text-ink-2">
        {L("Arus bersih", "Net flow")} <span className={`num ${net >= 0 ? "text-up" : "text-down"}`}>{usd(net, { sign: true })}</span>
      </p>
      <div className="max-h-72 overflow-auto">
        <table className="data">
          <tbody>
            {f.slice(0, 200).map((x, i) => (
              <tr key={x.tx + i}>
                <td className="text-ink-3">{ago(x.t)}</td>
                <td className={x.amount >= 0 ? "text-up" : "text-down"}>{x.amount >= 0 ? L("Deposit", "Deposit") : L("Tarik", "Withdraw")}</td>
                <td className="r">{usd(Math.abs(x.amount))}</td>
                <td className="r">
                  <a className="text-ink-3 hover:text-ink-2" href={explorerTx(x.tx)} target="_blank" rel="noreferrer">
                    tx
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
