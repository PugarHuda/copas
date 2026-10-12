import { Empty, Stat } from "@/components/ui";
import { TimeChart } from "@/components/TimeChart";
import { bookRisk, marketHistory, traderCohorts } from "@/lib/perpl/analytics";
import { num, pct, usd } from "@/lib/format";

type Lx = (a: string, b: string) => string;
const PALETTE = ["#3987e5", "#3fc792", "#e5a839", "#b77be5", "#f26d6d", "#5cc8d6"];
const NO_IDX = (L: Lx) => <Empty>{L("Indexer Envio belum tersinkron; panel ini butuh histori penuh.", "The Envio indexer is not synced yet; this panel needs the full history.")}</Empty>;

/** Market × day grid of daily-average funding APR (Envio MarketDaily). */
export async function FundingHeatmap({ L, idx }: { L: Lx; idx: boolean }) {
  if (!idx) return NO_IDX(L);
  const h = await marketHistory(30).catch(() => null);
  if (!h?.markets.length) return NO_IDX(L);
  const cap = 50; // APR % at full colour
  const bg = (v: number | null) => {
    if (v == null) return undefined;
    const a = Math.min(1, Math.abs(v) / cap) * 0.85 + 0.05;
    return v >= 0 ? `rgba(63,199,146,${a})` : `rgba(242,109,109,${a})`;
  };
  const day = (t: number) => new Date(t).toISOString().slice(5, 10);
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-[2px] text-[11px]">
          <thead>
            <tr>
              <th className="sticky left-0 bg-surface pr-2 text-left font-normal text-ink-3">Market</th>
              {h.dates.map((t, i) => (
                <th key={t} className="w-6 font-normal text-ink-3">
                  {i % 5 === 0 ? day(t) : ""}
                </th>
              ))}
              <th className="pl-2 text-right font-normal text-ink-3">{L("Rata2 30h", "30d avg")}</th>
            </tr>
          </thead>
          <tbody>
            {h.markets.map((m) => {
              const xs = m.funding.filter((x): x is number => x != null);
              const avg = xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null;
              return (
                <tr key={m.id}>
                  <td className="sticky left-0 bg-surface pr-2 text-ink-2">{m.name}</td>
                  {m.funding.map((v, i) => (
                    <td key={i} title={`${m.name} ${day(h.dates[i])}: ${v == null ? "–" : pct(v, 1, true)} APR`} className="h-5 min-w-5 rounded-sm" style={{ background: bg(v) ?? "var(--surface-2)" }} />
                  ))}
                  <td className={`num pl-2 text-right ${avg == null ? "" : avg >= 0 ? "text-up" : "text-down"}`}>{pct(avg, 1, true)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-ink-3">
        {L(
          `Rata-rata harian FundingEventCompleted.actualRate, disetahunkan. Hijau: long membayar short; merah: short membayar long; warna penuh di ±${cap}% APR. Sumber: Envio MarketDaily (event onchain), bukan jendela 128 interval API.`,
          `Daily average of FundingEventCompleted.actualRate, annualised. Green: longs pay shorts; red: shorts pay longs; full colour at ±${cap}% APR. Source: Envio MarketDaily (onchain events), not the API's 128-interval window.`,
        )}
      </p>
    </>
  );
}

/** Open interest per market, 90 days (Envio MarketDaily snapshot at each day's last event). */
export async function OiHistory({ L, idx }: { L: Lx; idx: boolean }) {
  if (!idx) return NO_IDX(L);
  const h = await marketHistory(90).catch(() => null);
  if (!h?.markets.length) return NO_IDX(L);
  const top = h.markets.slice(0, PALETTE.length);
  return (
    <>
      <TimeChart
        ariaLabel={L("Open interest per market", "Open interest by market")}
        height={240}
        series={top.map((m, i) => ({ name: m.name, kind: "line" as const, color: PALETTE[i], data: h.dates.map((t, j) => ({ t: t + 86_399_000, v: m.oi[j] })) }))}
      />
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
        {top.map((m, i) => (
          <span key={m.id} className="inline-flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-0.5 w-3" style={{ background: PALETTE[i] }} />
            {m.name} {usd(m.oi[m.oi.length - 1], { compact: true })}
          </span>
        ))}
      </div>
      <p className="mt-2 text-xs text-ink-3">{L("OI = (long + short) / 2 × harga fill terakhir hari itu. Sumber: Envio MarketDaily.", "OI = (long + short) / 2 × the day's last fill price. Source: Envio MarketDaily.")}</p>
    </>
  );
}

const bps = (v: number | null) => (v == null ? "> book" : `${num(v, v < 10 ? 1 : 0)} bp`);

/** Can the resting book absorb the liquidations a 5% move would trigger? */
export async function BookRisk({ L }: { L: Lx }) {
  const rows = await bookRisk().catch(() => null);
  if (!rows?.length) return <Empty>{L("Order book Perpl sedang tidak tersedia.", "The Perpl order book is unavailable right now.")}</Empty>;
  const cover = (depth: number, liq: number) => (liq >= 1000 ? depth / liq : null); // ratio over a few dollars of liqs is noise
  const tone = (c: number | null) => (c == null ? "text-ink-3" : c < 1 ? "text-down" : c < 3 ? "text-warn" : "text-up");
  return (
    <>
      <div className="overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>Market</th>
              <th className="r">Spread</th>
              <th className="r">{L("Bid ±1%", "Bids ±1%")}</th>
              <th className="r">{L("Ask ±1%", "Asks ±1%")}</th>
              <th className="r">{L("Jual $10K", "Sell $10K")}</th>
              <th className="r">{L("Jual $100K", "Sell $100K")}</th>
              <th className="r">{L("Beli $100K", "Buy $100K")}</th>
              <th className="r">{L("Likuidasi long −5%", "Long liqs −5%")}</th>
              <th className="r">{L("Bid 5% / likuidasi", "Bids 5% / liqs")}</th>
              <th className="r">{L("Likuidasi short +5%", "Short liqs +5%")}</th>
              <th className="r">{L("Ask 5% / likuidasi", "Asks 5% / liqs")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const cl = cover(r.bid5, r.longLiq5);
              const cs = cover(r.ask5, r.shortLiq5);
              return (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td className="r">{bps(r.spreadBps)}</td>
                  <td className="r">{usd(r.bid1, { compact: true })}</td>
                  <td className="r">{usd(r.ask1, { compact: true })}</td>
                  <td className="r">{bps(r.sell10k)}</td>
                  <td className={`r ${r.sell100k == null ? "text-down" : ""}`}>{bps(r.sell100k)}</td>
                  <td className={`r ${r.buy100k == null ? "text-down" : ""}`}>{bps(r.buy100k)}</td>
                  <td className="r">{usd(r.longLiq5, { compact: true })}</td>
                  <td className={`r ${tone(cl)}`}>{cl == null ? "–" : `${num(cl, 1)}×`}</td>
                  <td className="r">{usd(r.shortLiq5, { compact: true })}</td>
                  <td className={`r ${tone(cs)}`}>{cs == null ? "–" : `${num(cs, 1)}×`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 px-4 pb-4 text-xs text-ink-3">
        {L(
          `Slippage vs mid untuk market order, dari GET /v1/market-data/:id/book (100 level per sisi, blok ${rows[0].block.toLocaleString("en-US")}). "> book" = 100 level tidak cukup. Likuidasi: notional posisi terbuka yang harga likuidasinya dalam 5% dari mark. Rasio < 1× (merah): bid/ask dalam 5% lebih tipis dari likuidasi yang akan dipicu, risiko kaskade.`,
          `Market-order slippage vs mid from GET /v1/market-data/:id/book (100 levels a side, block ${rows[0].block.toLocaleString("en-US")}). "> book" = 100 levels are not enough. Liqs: notional of open positions whose liquidation price is within 5% of mark. Ratio < 1× (red): the book within 5% is thinner than the liquidations that move would trigger, a cascade risk.`,
        )}
      </p>
    </>
  );
}

/** Who wins on Perpl: every trader bucketed by lifetime volume (Envio Account). */
export async function Cohorts({ L, idx }: { L: Lx; idx: boolean }) {
  if (!idx) return NO_IDX(L);
  const c = await traderCohorts().catch(() => null);
  if (!c?.traders) return NO_IDX(L);
  return (
    <>
      <div className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-4">
        <Stat label={L("Trader terindeks", "Indexed traders")} value={num(c.traders, 0)} />
        <Stat label={L("Rugi setelah fee", "Net losers after fees")} value={pct(((c.traders - c.profitable) / c.traders) * 100, 0)} tone="text-down" />
        <Stat label={L("Total PnL bersih", "Total net PnL")} value={usd(c.netPnl, { compact: true, sign: true })} tone={c.netPnl >= 0 ? "text-up" : "text-down"} sub={`${L("Fee dibayar", "Fees paid")} ${usd(c.fees, { compact: true })}`} />
        <Stat label={L("Profit diambil top 1%", "Profit taken by top 1%")} value={pct(c.top1, 0)} />
      </div>
      <div className="overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>{L("Volume seumur hidup", "Lifetime volume")}</th>
              <th className="r">Trader</th>
              <th className="r">{L("Profit", "In profit")}</th>
              <th className="r">{L("Win rate median", "Median win rate")}</th>
              <th className="r">{L("PnL median", "Median PnL")}</th>
              <th className="r">{L("PnL total", "Total PnL")}</th>
              <th className="r">{L("Fee", "Fees")}</th>
              <th className="r">{L("Pernah dilikuidasi", "Ever liquidated")}</th>
            </tr>
          </thead>
          <tbody>
            {c.cohorts.map((b) => (
              <tr key={b.label}>
                <td>{b.label}</td>
                <td className="r">{num(b.traders, 0)}</td>
                <td className="r">{pct((b.profitable / b.traders) * 100, 0)}</td>
                <td className="r">{pct(b.winRate, 0)}</td>
                <td className={`r ${b.medianPnl >= 0 ? "text-up" : "text-down"}`}>{usd(b.medianPnl, { sign: true })}</td>
                <td className={`r ${b.netPnl >= 0 ? "text-up" : "text-down"}`}>{usd(b.netPnl, { compact: true, sign: true })}</td>
                <td className="r text-ink-2">{usd(b.fees, { compact: true })}</td>
                <td className="r">{pct((b.liquidated / b.traders) * 100, 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="px-4 pb-4 pt-2 text-xs text-ink-3">
        {L(
          "Semua akun Perpl mainnet dengan minimal satu fill (Envio Account). PnL = realized + funding − fee; posisi terbuka tidak dihitung.",
          "Every Perpl mainnet account with at least one fill (Envio Account). PnL = realized + funding − fees; open positions are not counted.",
        )}
      </p>
    </>
  );
}
