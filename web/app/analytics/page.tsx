import Link from "next/link";
import { Suspense } from "react";
import type { Metadata } from "next";
import { Panel, PageHead, Segmented, Source, Stat, StatRow, Empty } from "@/components/ui";
import { TimeChart } from "@/components/TimeChart";
import { FLOW_DAYS, activeUsers, flows, fundingHistory, markets, protocolSnapshot, tvlHistory, volumeHistory } from "@/lib/perpl/analytics";
import { getLeaderboard } from "@/lib/perpl/api";
import { indexerFresh, indexerSyncedAt } from "@/lib/perpl/indexer";
import { ago, num, pct, price, short, usd } from "@/lib/format";
import { explorerTx } from "@/lib/chains";
import { getT } from "@/lib/i18n/server";
import { OracleCheckPanel } from "@/components/OracleCheck";
import { LiquidationLadder, LiveMarkets, WalletSearch, Watchlist } from "./_c/client";
import { BookRisk, Cohorts, FundingHeatmap, OiHistory } from "./_c/risk";

export const metadata: Metadata = { title: "Perpl analytics" };
export const revalidate = 30;

type SP = Promise<{ vt?: string; fw?: string }>;
const DAY = 86_400_000;
const C1 = "#3987e5";
const UP = "#3fc792";
const DOWN = "#f26d6d";

export default async function AnalyticsPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const { t, lang } = await getT();
  const L = (a: string, b: string) => (lang === "id" ? a : b);
  const vt = ["30d", "90d", "all"].includes(sp.vt ?? "") ? sp.vt! : "90d";
  const idx = await indexerFresh();
  // fw = window in days for flows/liquidations; 0 = full indexed history (indexer only)
  const fw = sp.fw === "1" ? 1 : idx ? (["7", "30"].includes(sp.fw ?? "") ? Number(sp.fw) : 0) : FLOW_DAYS;
  const q = (k: string, v: string) => `/analytics?${new URLSearchParams({ vt, fw: String(fw), [k]: v })}`;

  return (
    <div className="space-y-6">
      <PageHead title={t("analytics.title")} lede={t("analytics.lede")}>
        <WalletSearch />
      </PageHead>

      {/* the stat grid wraps to 2 or 3 rows on narrow screens: reserve its real height (measured) so the page below does not jump */}
      <Suspense fallback={<div className="h-[397px] animate-pulse rounded bg-surface-2/60 sm:h-[303px] lg:h-[197px]" aria-hidden />}>
        <Headline L={L} />
      </Suspense>

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title={L("Volume harian", "Daily volume")}
          aside={
            <Segmented
              active={vt}
              items={[
                { key: "30d", label: "30D", href: q("vt", "30d") },
                { key: "90d", label: "90D", href: q("vt", "90d") },
                { key: "all", label: L("Semua", "All"), href: q("vt", "all") },
              ]}
            />
          }
        >
          <Suspense fallback={<Skeleton h={260} />}>
            <VolumeChart vt={vt} L={L} />
          </Suspense>
        </Panel>
        <Panel title={L("Pangsa volume per market, 30 hari", "Volume share by market, 30 days")}>
          <Suspense fallback={<Skeleton h={260} />}>
            <MarketShare />
          </Suspense>
        </Panel>
      </div>

      <Panel title={L("Market, live", "Markets, live")} aside={<Source kind="live">{L("Ticker Perpl + posisi onchain", "Perpl ticker + onchain positions")}</Source>} pad={false}>
        <Suspense fallback={<Skeleton h={420} />}>
          <Markets />
        </Suspense>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel
          className="lg:col-span-2"
          title={L("Arus dana: deposit dan penarikan", "Capital flows: deposits and withdrawals")}
          aside={
            <Segmented
              active={String(fw)}
              items={
                idx
                  ? [
                      { key: "1", label: "24H", href: q("fw", "1") },
                      { key: "7", label: "7D", href: q("fw", "7") },
                      { key: "30", label: "30D", href: q("fw", "30") },
                      { key: "0", label: L("Semua", "All"), href: q("fw", "0") },
                    ]
                  : [
                      { key: "1", label: "24H", href: q("fw", "1") },
                      { key: String(FLOW_DAYS), label: `${FLOW_DAYS}D`, href: q("fw", String(FLOW_DAYS)) },
                    ]
              }
            />
          }
        >
          <Suspense fallback={<Skeleton h={300} />}>
            <Flows days={fw} L={L} />
          </Suspense>
        </Panel>
        <Panel
          title={idx ? L("Deposit bersih kumulatif", "Cumulative net deposits") : L("TVL exchange, 5 hari", "Exchange TVL, 5 days")}
          aside={idx ? <Source kind="indexer">ProtocolDaily</Source> : <Source kind="rpc">{L("State historis onchain", "Historical onchain state")}</Source>}
        >
          <Suspense fallback={<Skeleton h={300} />}>
            <Tvl L={L} />
          </Suspense>
        </Panel>
      </div>

      <Panel title={L("Funding, 3,5 hari terakhir (APR)", "Funding, last 3.5 days (APR)")} aside={<Source kind="live">/market-data/funding</Source>}>
        <Suspense fallback={<Skeleton h={300} />}>
          <Funding L={L} />
        </Suspense>
      </Panel>

      <Panel title={L("Heatmap funding, 30 hari (APR rata-rata harian)", "Funding heatmap, 30 days (daily average APR)")} aside={<Source kind="indexer">Envio MarketDaily</Source>}>
        <Suspense fallback={<Skeleton h={300} />}>
          <FundingHeatmap L={L} idx={idx} />
        </Suspense>
      </Panel>

      <Panel title={L("Open interest per market, 90 hari", "Open interest by market, 90 days")} aside={<Source kind="indexer">Envio MarketDaily</Source>}>
        <Suspense fallback={<Skeleton h={280} />}>
          <OiHistory L={L} idx={idx} />
        </Suspense>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-5">
        <Panel className="lg:col-span-3" title={L("Likuidasi", "Liquidations")} aside={<Source kind={idx ? "indexer" : "rpc"}>{idx ? "Liquidation" : "PositionLiquidated"}</Source>}>
          <Suspense fallback={<Skeleton h={360} />}>
            <Liquidations days={fw} L={L} />
          </Suspense>
        </Panel>
        <Panel className="lg:col-span-2" title={L("Peta likuidasi", "Liquidation map")} aside={<Source kind="rpc">{L("Semua posisi terbuka", "All open positions")}</Source>}>
          <Suspense fallback={<Skeleton h={360} />}>
            <Ladder />
          </Suspense>
        </Panel>
      </div>

      <Panel title={L("Likuiditas vs tekanan likuidasi", "Liquidity vs liquidation pressure")} aside={<Source kind="live">{L("Order book Perpl + posisi onchain", "Perpl order book + onchain positions")}</Source>} pad={false}>
        <Suspense fallback={<Skeleton h={360} />}>
          <BookRisk L={L} />
        </Suspense>
      </Panel>

      <OracleCheckPanel chain={143} L={L} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={L("Posisi paling dekat likuidasi", "Positions closest to liquidation")} pad={false}>
          <Suspense fallback={<Skeleton h={360} />}>
            <RiskTable kind="atRisk" L={L} />
          </Suspense>
        </Panel>
        <Panel title={L("Posisi terbuka terbesar", "Largest open positions")} pad={false}>
          <Suspense fallback={<Skeleton h={360} />}>
            <RiskTable kind="largest" L={L} />
          </Suspense>
        </Panel>
      </div>

      <Panel title={L("Kohort trader: siapa yang untung di Perpl", "Trader cohorts: who makes money on Perpl")} aside={<Source kind="indexer">Envio Account</Source>} pad={false}>
        <Suspense fallback={<Skeleton h={320} />}>
          <Cohorts L={L} idx={idx} />
        </Suspense>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel className="lg:col-span-2" title={L("Trader teratas, PnL 30 hari", "Top traders, 30-day PnL")} pad={false} aside={<Source kind="live">/trading/leaderboard</Source>}>
          <Suspense fallback={<Skeleton h={360} />}>
            <TopTraders L={L} />
          </Suspense>
        </Panel>
        <Panel title={L("Wallet dipantau", "Watched wallets")}>
          <Watchlist />
        </Panel>
      </div>
    </div>
  );
}

type Lx = (a: string, b: string) => string;

/** Source footnote for indexer-backed sections: the indexer may still be syncing. */
async function envioNote(L: Lx, what: string) {
  const at = await indexerSyncedAt().catch(() => 0);
  const when = at ? new Date(at).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "?";
  return L(`Indexer Envio (${what}), seluruh histori, tersinkron sampai ${when}.`, `Envio indexer (${what}), full history, synced to ${when}.`);
}

function Skeleton({ h }: { h: number }) {
  return <div className="animate-pulse rounded bg-surface-2/60" style={{ height: h }} aria-hidden />;
}

async function Headline({ L }: { L: Lx }) {
  const [p, v, a, f] = await Promise.all([protocolSnapshot(), volumeHistory(), activeUsers(), flows(FLOW_DAYS).catch(() => null)]);
  const vol24 = p.rows.reduce((s, r) => s + r.vol24h, 0);
  const oi = p.rows.reduce((s, r) => s + r.oiNotional, 0);
  const net = f ? f.totals.deposits - f.totals.withdrawals : null;
  return (
    <Panel aside={<Source kind="live">{L(`Blok ${p.block.toLocaleString("en-US")}, diperbarui ${ago(p.at)} lalu`, `Block ${p.block.toLocaleString("en-US")}, updated ${ago(p.at)} ago`)}</Source>} title={L("Protokol", "Protocol")}>
      <StatRow>
        <Stat label={L("Volume 24 jam", "24h volume")} value={usd(vol24, { compact: true })} sub={`7d ${usd(v.v7d, { compact: true })}`} />
        <Stat label={L("Volume 30 hari", "30d volume")} value={usd(v.v30d, { compact: true })} sub={`${L("Semua", "All-time")} ${usd(v.vAll, { compact: true })}`} />
        <Stat label="Open interest" value={usd(oi, { compact: true })} sub={`${num(p.openPositions, 0)} ${L("posisi", "positions")}`} />
        <Stat label="TVL" value={usd(p.tvl, { compact: true })} sub={net != null ? `${f!.days ? L(`Arus bersih ${f!.days}h`, `${f!.days}d net flow`) : L("Arus bersih total", "All-time net flow")} ${usd(net, { compact: true, sign: true })}` : undefined} />
        <Stat
          label={L("Saldo fee protokol", "Protocol fee balance")}
          value={usd(p.protocolBalance, { compact: true })}
          sub={`${L("Est. fee 24j", "Est. 24h fees")} ${usd(vol24 * 0.00039, { compact: true })}`}
        />
        <Stat label={L("Trader aktif 24j", "Active traders 24h")} value={num(a.day.active, 0)} sub={`7d ${num(a.week.active, 0)} · 30d ${num(a.month.active, 0)} · ${num(p.accounts, 0)} ${L("akun", "accounts")}`} />
      </StatRow>
      <p className="mt-4 text-xs text-ink-3">
        {L(
          `Fee 24 jam diestimasi dari volume × (taker 3,45 bp + maker 0,45 bp) tier dasar. ${pct((a.month.profitable / Math.max(1, a.month.active)) * 100, 0)} trader aktif 30 hari sedang profit.`,
          `24h fees estimated as volume × (3.45 bp taker + 0.45 bp maker) at base tier. ${pct((a.month.profitable / Math.max(1, a.month.active)) * 100, 0)} of traders active in the last 30 days are in profit.`,
        )}
      </p>
    </Panel>
  );
}

async function VolumeChart({ vt, L }: { vt: string; L: Lx }) {
  const v = await volumeHistory();
  const since = vt === "all" ? 0 : Date.now() - (vt === "30d" ? 30 : 90) * DAY;
  const days = v.days.filter((d) => d.t >= since);
  return (
    <>
      <TimeChart ariaLabel={L("Volume harian", "Daily volume")} height={260} series={[{ name: L("Volume", "Volume"), kind: "histogram", color: C1, data: days.map((d) => ({ t: d.t, v: d.total })) }]} />
      <p className="mt-2 text-xs text-ink-3">{L("Candle 1 hari dari semua market, dijumlahkan. Sumber: /market-data/:id/candles.", "1-day candles summed across all markets. Source: /market-data/:id/candles.")}</p>
    </>
  );
}

async function MarketShare() {
  const v = await volumeHistory();
  const tot = v.share30d.reduce((a, [, x]) => a + x, 0);
  const max = v.share30d[0]?.[1] ?? 1;
  return (
    <ul className="space-y-2.5">
      {v.share30d.map(([name, x]) => (
        <li key={name} className="grid grid-cols-[52px_1fr_92px] items-center gap-3 text-sm">
          <span>{name}</span>
          <div className="h-1.5 rounded-sm bg-surface-2">
            <div className="h-1.5 rounded-sm bg-[var(--c1)]" style={{ width: `${(x / max) * 100}%` }} />
          </div>
          <span className="num text-right text-ink-2">
            {pct((x / tot) * 100, 1)} <span className="text-ink-3">{usd(x, { compact: true })}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

async function Markets() {
  const [p, ms] = await Promise.all([protocolSnapshot(), markets()]);
  return <LiveMarkets rows={p.rows} meta={ms.map((m) => ({ id: m.id, pd: m.pd, sd: m.sd }))} />;
}

async function Flows({ days, L }: { days: number; L: Lx }) {
  const f = await flows(FLOW_DAYS).catch(() => null);
  if (!f) return <Empty>{L("RPC log sedang tidak tersedia. Coba lagi sebentar.", "The log RPC is unavailable right now. Try again shortly.")}</Empty>;
  const since = days ? Date.now() - days * DAY : 0;
  const daily = f.daily.filter((d) => d.t >= since);
  const dep = daily.reduce((a, d) => a + d.deposits, 0);
  const wd = daily.reduce((a, d) => a + d.withdrawals, 0);
  return (
    <>
      <div className="mb-4 grid grid-cols-3 gap-4">
        <Stat label={L("Deposit", "Deposits")} value={usd(dep, { compact: true })} tone="text-up" />
        <Stat label={L("Penarikan", "Withdrawals")} value={usd(wd, { compact: true })} tone="text-down" />
        <Stat label={L("Arus bersih", "Net flow")} value={usd(dep - wd, { compact: true, sign: true })} tone={dep - wd >= 0 ? "text-up" : "text-down"} />
      </div>
      <TimeChart
        ariaLabel={L("Deposit dan penarikan harian", "Daily deposits and withdrawals")}
        height={220}
        series={[
          { name: L("Deposit", "Deposits"), kind: "histogram", color: UP, data: daily.map((d) => ({ t: d.t, v: d.deposits })) },
          { name: L("Penarikan", "Withdrawals"), kind: "histogram", color: DOWN, data: daily.map((d) => ({ t: d.t, v: -d.withdrawals })) },
        ]}
      />
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-xs text-ink-3 hover:text-ink-2">{L("Arus terbaru", "Latest flows")}</summary>
        <div className="mt-2 max-h-72 overflow-auto">
          <table className="data">
            <tbody>
              {f.recentFlows.slice(0, 25).map((x) => (
                <tr key={x.tx + x.accountId + x.kind}>
                  <td className="text-ink-3">{ago(x.t)}</td>
                  <td className={x.kind === "deposit" ? "text-up" : "text-down"}>{x.kind === "deposit" ? L("Deposit", "Deposit") : L("Tarik", "Withdraw")}</td>
                  <td className="r">{usd(x.amount)}</td>
                  <td>
                    <Link className="num hover:text-gold-2" href={`/analytics/wallet/${x.address ?? x.accountId}`}>
                      {x.address ? short(x.address) : `#${x.accountId}`}
                    </Link>
                  </td>
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
      </details>
      <p className="mt-2 text-xs text-ink-3">
        {f.source === "envio"
          ? await envioNote(L, "CollateralFlow")
          : L("Event CollateralDeposit / CollateralWithdrawal dari kontrak exchange.", "CollateralDeposit / CollateralWithdrawal events from the exchange contract.")}
      </p>
    </>
  );
}

async function Tvl({ L }: { L: Lx }) {
  const { source, pts } = await tvlHistory().catch(() => ({ source: "rpc" as const, pts: [] }));
  if (!pts.length) return <Empty>{L("State historis tidak tersedia.", "Historical state unavailable.")}</Empty>;
  const first = pts[0].tvl;
  const last = pts[pts.length - 1].tvl;
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-4">
        <Stat label={source === "envio" ? L("Deposit bersih", "Net deposits") : L("TVL sekarang", "TVL now")} value={usd(last, { compact: true })} />
        <Stat
          label={source === "envio" ? L("Perubahan 7 hari", "7-day change") : L("Perubahan 5 hari", "5-day change")}
          value={(() => {
            const base = source === "envio" ? (pts[Math.max(0, pts.length - 8)]?.tvl ?? first) : first;
            return pct(base ? ((last - base) / base) * 100 : null, 2, true);
          })()}
          tone={last >= first ? "text-up" : "text-down"}
        />
      </div>
      <TimeChart ariaLabel="TVL" height={200} series={[{ name: "TVL", kind: "area", color: C1, data: pts.map((p) => ({ t: p.t, v: p.tvl })) }]} />
      <p className="mt-2 text-xs text-ink-3">
        {source === "envio"
          ? `${L("Deposit − penarikan kumulatif per hari (proxy TVL, tanpa PnL trader).", "Cumulative deposits − withdrawals per day (TVL proxy, excludes trader PnL).")} ${await envioNote(L, "ProtocolDaily")}`
          : L("Saldo AUSD exchange (getExchangeInfo) di 48 blok historis. RPC publik menyimpan state ±130 jam.", "Exchange AUSD balance (getExchangeInfo) at 48 historical blocks. The public RPC keeps ~130h of state.")}
      </p>
    </>
  );
}

async function Funding({ L }: { L: Lx }) {
  const fh = await fundingHistory();
  return (
    <>
      <div className="grid gap-x-6 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
        {fh.map((m) => (
          <div key={m.id}>
            <div className="mb-1 flex items-baseline justify-between text-sm">
              <span className="font-medium">{m.name}</span>
              <span className="num text-xs text-ink-3">
                {L("kini", "now")} <span className={m.current > 0 ? "text-up" : m.current < 0 ? "text-down" : "text-ink-2"}>{pct(m.current, 1, true)}</span> · 24h {pct(m.avg24h, 1, true)}
              </span>
            </div>
            <TimeChart ariaLabel={`${m.name} funding`} height={80} format="pct" series={[{ name: "", kind: "line", color: C1, data: m.points.map((p) => ({ t: p.t, v: p.apr })) }]} />
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-ink-3">{L("Rate per interval funding (±43 menit) disetahunkan. Positif: long membayar short.", "Per-interval funding rate (~43 min) annualised. Positive: longs pay shorts.")}</p>
    </>
  );
}

async function Liquidations({ days, L }: { days: number; L: Lx }) {
  const f = await flows(FLOW_DAYS).catch(() => null);
  if (!f) return <Empty>{L("RPC log sedang tidak tersedia.", "The log RPC is unavailable right now.")}</Empty>;
  const since = days ? Date.now() - days * DAY : 0;
  const daily = f.daily.filter((d) => d.t >= since);
  const ls = f.liqsAll.filter((x) => x.t >= since);
  const longN = ls.filter((x) => x.side === "long").reduce((a, x) => a + x.notional, 0);
  const shortN = ls.filter((x) => x.side === "short").reduce((a, x) => a + x.notional, 0);
  return (
    <>
      <div className="mb-4 grid grid-cols-3 gap-4">
        <Stat label={days ? L(`Likuidasi ${days} hari`, `Liquidations, ${days}d`) : L("Likuidasi, semua", "Liquidations, all-time")} value={num(ls.length, 0)} />
        <Stat label={L("Notional long", "Long notional")} value={usd(longN, { compact: true })} />
        <Stat label={L("Notional short", "Short notional")} value={usd(shortN, { compact: true })} />
      </div>
      <TimeChart ariaLabel={L("Notional likuidasi harian", "Daily liquidated notional")} height={160} series={[{ name: L("Notional terlikuidasi", "Liquidated notional"), kind: "histogram", color: "#d95926", data: daily.map((d) => ({ t: d.t, v: d.liqNotional })) }]} />
      <div className="mt-4 max-h-64 overflow-auto">
        <table className="data">
          <thead>
            <tr>
              <th>{L("Waktu", "Time")}</th>
              <th>Market</th>
              <th>{L("Arah", "Side")}</th>
              <th className="r">{L("Harga", "Price")}</th>
              <th className="r">Notional</th>
              <th className="r">PnL</th>
              <th>Wallet</th>
            </tr>
          </thead>
          <tbody>
            {f.recentLiqs.slice(0, 20).map((x) => (
              <tr key={x.tx + x.accountId + x.market}>
                <td className="text-ink-3">
                  <a href={explorerTx(x.tx)} target="_blank" rel="noreferrer" className="hover:text-ink-2">
                    {ago(x.t)}
                  </a>
                </td>
                <td>{x.market}</td>
                <td className={x.side === "long" ? "text-up" : "text-down"}>{x.side === "long" ? "Long" : "Short"}</td>
                <td className="r">{price(x.price)}</td>
                <td className="r">{usd(x.notional)}</td>
                <td className="r text-down">{usd(x.pnl, { sign: true })}</td>
                <td>
                  <Link className="num hover:text-gold-2" href={`/analytics/wallet/${x.address ?? x.accountId}`}>
                    {x.address ? short(x.address) : `#${x.accountId}`}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {f.source === "envio" && <p className="mt-2 text-xs text-ink-3">{await envioNote(L, "Liquidation")}</p>}
    </>
  );
}

async function Ladder() {
  const p = await protocolSnapshot();
  const ms = [...p.rows].sort((a, b) => b.oiNotional - a.oiNotional).map((r) => ({ id: r.id, name: r.name, mark: r.mark }));
  return <LiquidationLadder ladder={p.ladder as never} markets={ms} />;
}

async function RiskTable({ kind, L }: { kind: "atRisk" | "largest"; L: Lx }) {
  const p = await protocolSnapshot();
  const rows = p[kind];
  return (
    <div className="overflow-x-auto" tabIndex={0}>
      <table className="data">
        <thead>
          <tr>
            <th>Wallet</th>
            <th>Market</th>
            <th className="r">Notional</th>
            <th className="r">Lev.</th>
            <th className="r">{L("Likuidasi", "Liq.")}</th>
            <th className="r">{L("Jarak", "Distance")}</th>
            <th className="r">uPnL</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.accountId}-${r.marketId}`}>
              <td>
                <Link className="num hover:text-gold-2" href={`/analytics/wallet/${r.address ?? r.accountId}`}>
                  {r.address ? short(r.address) : `#${r.accountId}`}
                </Link>
              </td>
              <td>
                {r.market} <span className={r.side === "long" ? "text-up" : "text-down"}>{r.side === "long" ? "L" : "S"}</span>
              </td>
              <td className="r">{usd(r.notional, { compact: true })}</td>
              <td className="r">{Number.isFinite(r.leverage) ? `${num(r.leverage, 1)}x` : "–"}</td>
              <td className="r">{price(r.liq)}</td>
              <td className={`r ${r.liqDistance != null && r.liqDistance < 3 ? "text-down" : r.liqDistance != null && r.liqDistance < 8 ? "text-warn" : ""}`}>{pct(r.liqDistance, 2)}</td>
              <td className={`r ${r.upnl >= 0 ? "text-up" : "text-down"}`}>{usd(r.upnl, { compact: true, sign: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function TopTraders({ L }: { L: Lx }) {
  const rows = (await getLeaderboard("month", "pnl")).slice(0, 12);
  return (
    <div className="overflow-x-auto" tabIndex={0}>
      <table className="data">
        <thead>
          <tr>
            <th>#</th>
            <th>Wallet</th>
            <th className="r">PnL 30d</th>
            <th className="r">ROI</th>
            <th className="r">{L("Volume", "Volume")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.address}>
              <td className="text-ink-3">{r.rank}</td>
              <td>
                <Link className="num hover:text-gold-2" href={`/analytics/wallet/${r.address}`}>
                  {short(r.address)}
                </Link>
              </td>
              <td className={`r ${r.pnl >= 0 ? "text-up" : "text-down"}`}>{usd(r.pnl, { sign: true })}</td>
              <td className="r">{pct(r.roi, 1, true)}</td>
              <td className="r text-ink-2">{usd(r.volume, { compact: true })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
