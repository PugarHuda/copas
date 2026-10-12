import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Panel, Source, Stat, StatRow, Empty, btn, Pill } from "@/components/ui";
import { Seal } from "@/components/Seal";
import { TimeChart } from "@/components/TimeChart";
import { DDMeter, StatusPill, protection } from "@/components/copas";
import { getLeader, perplPositions } from "@/lib/copas/data";
import { leaderCheckpoints, type LiveCheckpoint } from "@/lib/copas/indexer";
import type { Leader } from "@/lib/copas/contracts";
import type { Position } from "@/lib/perpl/onchain";
import { walletPeriods, walletSnapshot } from "@/lib/perpl/analytics";
import { getT } from "@/lib/i18n/server";
import { ago, isAddress, num, pct, pctAuto, price, short, usd } from "@/lib/format";
import { copasChain, explorerAddr, explorerTx } from "@/lib/chains";
import { StrategyFeed } from "@/components/StrategyFeed";
import { AlignmentBadge, AnalysisPanel, AttestedBadge, BacktestPanel } from "@/components/services";

type P = Promise<{ addr: string }>;
type Lx = (a: string, b: string) => string;

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const { addr } = await params;
  if (!isAddress(addr)) return { title: "Not found" };
  const leader = await getLeader(addr);
  return { title: leader?.name ?? `Shadow ${short(addr)}` };
}

export default async function LeaderPage({ params }: { params: P }) {
  const { addr } = await params;
  if (!isAddress(addr)) notFound();
  const { t, lang } = await getT();
  const L: Lx = (a, b) => (lang === "id" ? a : b);
  const leader = await getLeader(addr);
  if (leader) {
    const [cps, positions] = await Promise.all([leaderCheckpoints(leader.book), perplPositions(leader.book).catch(() => null)]);
    return <Bonded l={leader} cps={cps} positions={positions} L={L} statusLabel={t(`status.${leader.status}`)} />;
  }
  return <ShadowProfile addr={addr.toLowerCase()} L={L} />;
}

function Bonded({ l, cps, positions: read, L, statusLabel }: { l: Leader; cps: LiveCheckpoint[] | null; positions: Position[] | null; L: Lx; statusLabel: string }) {
  // unit price and the epoch peak it is measured against, oldest first; peak = u / (1 − dd)
  const curve = (cps ?? []).filter((c) => Number.isFinite(c.unitPrice)).reverse().map((c) => ({ t: c.t, u: c.unitPrice, hwm: c.unitPrice / (1 - c.ddPct / 100) }));
  const positions = read ?? [];
  const prot = protection(l);
  const gross = positions.reduce((a, p) => a + p.notional, 0);
  const effLev = l.equity > 0 ? gross / l.equity : 0; // same as the contract: gross notional / equity
  const outside = positions.filter((p) => !l.markets.includes(p.market));
  const hoursLeft = Math.max(0, (l.epochEnd - Date.now()) / 3_600_000);
  const mandate: { label: string; promise: string; now: string; ok: boolean }[] = [
    { label: L("Drawdown maks per epoch", "Max drawdown per epoch"), promise: pctAuto(l.maxDD), now: pctAuto(l.liveDD), ok: l.liveDD <= l.maxDD },
    { label: L("Leverage maks", "Max leverage"), promise: `${l.maxLeverage}x`, now: `${num(effLev, 1)}x`, ok: effLev <= l.maxLeverage },
    { label: L("Market yang diizinkan", "Allowed markets"), promise: l.markets.join(", "), now: outside.length ? outside.map((p) => p.market).join(", ") : L("semua di dalam mandat", "all inside mandate"), ok: !outside.length },
    { label: L("Notional maks", "Max notional"), promise: usd(l.maxNotional, { dp: 0 }), now: usd(gross, { dp: 0 }), ok: gross <= l.maxNotional },
    { label: L("Jaminan minimum", "Minimum bond"), promise: usd(Math.max(25, l.followerAum * 0.1), { dp: 0 }), now: usd(l.bond, { dp: 0 }), ok: l.bond >= Math.max(25, l.followerAum * 0.1) },
  ];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-6">
        <Seal bond={l.bond + l.underwritten} maxDD={l.maxDD} breached={l.status === "breached"} size="lg" label={L("Jaminan AUSD", "AUSD bond")} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="break-all font-cond text-3xl font-semibold sm:text-4xl">{l.name}</h1>
            <StatusPill status={l.status} label={statusLabel} />
            {l.agent && <Pill tone="gold">AI agent{l.agent.erc8004Id ? ` · ERC-8004 #${l.agent.erc8004Id}` : ""}</Pill>}
          </div>
          <div className="mt-2 grid gap-1 text-xs text-ink-3">
            <span className="break-all">
              LeaderBook{" "}
              <a className="num hover:text-ink-2" href={explorerAddr(l.book, copasChain.id)} target="_blank" rel="noreferrer">
                {l.book}
              </a>
            </span>
            <span className="break-all">
              {L("Pemilik", "Owner")} <span className="num">{l.owner}</span>
            </span>
            {l.agent && <span>{l.agent.model}</span>}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <AttestedBadge perplAddress={l.perplAccount} />
            <AlignmentBadge perplAddress={l.perplAccount} />
          </div>
          <p className="mt-3 max-w-2xl text-sm text-ink-2">
            {l.status === "breached"
              ? L(
                  `${l.name} melanggar mandat di epoch ${l.epoch}: unit price turun lebih dari ${l.maxDD}% dari puncak epoch, jadi jaminannya dipotong dan dibayarkan ke follower. Sisa jaminan: ${usd(l.bond, { dp: 0 })}.`,
                  `${l.name} broke its mandate in epoch ${l.epoch}: the unit price fell more than ${l.maxDD}% below the epoch peak, so the bond was slashed and paid to followers. Bond left: ${usd(l.bond, { dp: 0 })}.`,
                )
              : L(
                  `${l.name} mempertaruhkan ${usd(l.bond, { dp: 0 })} miliknya sendiri${l.underwritten ? ` plus ${usd(l.underwritten, { dp: 0 })} dari penjamin` : ""}. Bila unit price turun lebih dari ${l.maxDD}% dari puncak epoch, jaminan dipotong dan dibayarkan ke follower.`,
                  `${l.name} stakes ${usd(l.bond, { dp: 0 })} of their own${l.underwritten ? ` plus ${usd(l.underwritten, { dp: 0 })} from underwriters` : ""}. If the unit price falls more than ${l.maxDD}% below the epoch peak, the bond is slashed and paid to followers.`,
                )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/market/${l.book}`} className={btn.ghost}>
            {L("Pasar DOWN", "DOWN market")}
          </Link>
          {l.status === "active" ? (
            <Link href={`/follow/${l.book}`} className={btn.primary}>
              {L("Ikuti leader ini", "Follow this leader")}
            </Link>
          ) : (
            <button type="button" disabled className={btn.ghost} title={L("Hanya leader aktif yang bisa diikuti", "Only active leaders can be followed")}>
              {L("Ikuti leader ini", "Follow this leader")}
            </button>
          )}
        </div>
      </div>

      <Panel title={L("Ringkasan epoch", "Epoch summary")} aside={<Source kind="live">LeaderBook</Source>}>
        <StatRow>
          <Stat label={L("Harga unit", "Unit price")} value={num(l.unitPrice, 4)} sub={`${pct(l.returnTotal, 1, true)} ${L("sejak awal", "since start")}`} />
          <Stat label={L("Puncak epoch (HWM)", "Epoch peak (HWM)")} value={num(l.peakUnitPrice, 4)} />
          <Stat label={L("Drawdown live / janji", "Drawdown live / declared")} value={<DDMeter live={l.liveDD} max={l.maxDD} />} />
          <Stat label={L("AUM / kapasitas", "AUM / capacity")} value={usd(l.followerAum, { dp: 0 })} sub={`${l.followers != null ? `${l.followers} ${l.followers === 1 ? "follower" : "followers"} · ` : ""}${pct(l.capacity ? (l.followerAum / l.capacity) * 100 : 0, 0)} ${L("dari", "of")} ${usd(l.capacity, { dp: 0 })}`} />
          <Stat label={L("Perlindungan maks", "Max protection")} value={pct(prot, 0)} sub={L("jaminan ÷ AUM", "stake ÷ AUM")} tone={prot < 25 ? "text-warn" : ""} />
          <Stat label={`${L("Epoch", "Epoch")} ${l.epoch} ${L("berakhir", "ends in")}`} value={`${num(hoursLeft, 0)}h`} sub={`${L("panjang", "length")} ${l.epochLenH}h`} />
        </StatRow>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel className="lg:col-span-2" title={L("Harga unit dan high-water mark epoch", "Unit price and epoch high-water mark")} aside={<Source kind="indexer">LeaderBook.Checkpoint</Source>}>
          {curve.length < 2 ? (
            <Empty>{cps ? L("Belum cukup checkpoint untuk grafik.", "Not enough checkpoints for a chart yet.") : L("Indexer tidak merespons; grafik dibangun dari checkpoint terindeks.", "The indexer did not respond; the chart is built from indexed checkpoints.")}</Empty>
          ) : (
          <TimeChart
            ariaLabel="Unit price"
            format="num"
            height={260}
            series={[
              { name: L("Harga unit", "Unit price"), kind: "line", color: "#3987e5", data: curve.map((p) => ({ t: p.t, v: p.u })) },
              { name: "HWM", kind: "line", color: "#d9b45c", data: curve.map((p) => ({ t: p.t, v: p.hwm })) },
            ]}
          />
          )}
          <p className="mt-2 text-xs text-ink-3">
            {L(
              "Harga unit = equity Perpl leader ÷ unit. Setoran dan penarikan mencetak/membakar unit, jadi tidak menggeser harga. HWM direset tiap awal epoch.",
              "Unit price = leader's Perpl equity ÷ units. Deposits and withdrawals mint/burn units, so they never move the price. HWM resets each epoch.",
            )}
          </p>
        </Panel>
        <Panel title={L("Mandat", "Mandate")} aside={<span>{L("dicek tiap checkpoint", "checked every checkpoint")}</span>}>
          <ul className="space-y-3">
            {mandate.map((m) => (
              <li key={m.label} className="grid grid-cols-[18px_1fr] gap-x-2 text-sm">
                <span aria-hidden className={m.ok ? "text-up" : "text-down"}>
                  {m.ok ? "✓" : "✕"}
                </span>
                <div>
                  <div className="flex justify-between gap-2">
                    <span className="text-ink-2">{m.label}</span>
                    <span className="num">{m.promise}</span>
                  </div>
                  <div className={`text-xs ${m.ok ? "text-ink-3" : "text-down"}`}>
                    {m.ok ? L("Sekarang", "Now") : L("Dilanggar", "Broken")}: <span className="num">{m.now}</span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-ink-3">{L(`Fee kinerja ${l.feePct}% di atas HWM follower, ditahan di escrow yang ikut terpotong bila melanggar.`, `${l.feePct}% performance fee above each follower's HWM, held in an escrow that is slashed on breach.`)}</p>
        </Panel>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={L("Posisi leader", "Leader positions")} pad={false} aside={<Source kind="rpc">Perpl getPosition</Source>}>
          {!read ? (
            <Empty>{L("RPC Monad tidak merespons. Coba lagi sebentar.", "The Monad RPC did not respond. Try again shortly.")}</Empty>
          ) : positions.length ? (
            <div className="overflow-x-auto">
            <table className="data">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>{L("Arah", "Side")}</th>
                  <th className="r">{L("Ukuran", "Size")}</th>
                  <th className="r">{L("Masuk", "Entry")}</th>
                  <th className="r">Mark</th>
                  <th className="r">Lev.</th>
                  <th className="r">uPnL</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.marketId}>
                    <td>{p.market}</td>
                    <td className={p.side === "long" ? "text-up" : "text-down"}>{p.side === "long" ? "Long" : "Short"}</td>
                    <td className="r">{num(p.size, 4)}</td>
                    <td className="r">{price(p.entry)}</td>
                    <td className="r">{price(p.mark)}</td>
                    <td className="r">{Number.isFinite(p.leverage) ? `${num(p.leverage, 1)}x` : "–"}</td>
                    <td className={`r ${p.upnl >= 0 ? "text-up" : "text-down"}`}>{usd(p.upnl, { sign: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          ) : (
            <Empty>{L("Tidak ada posisi terbuka.", "No open positions.")}</Empty>
          )}
        </Panel>
        <Panel title={L("Analisis risiko AI", "AI risk analysis")} aside={<span>{L("AI menjelaskan, kontrak mengeksekusi", "AI explains, the contract enforces")}</span>}>
          <AnalysisPanel perplAddress={l.perplAccount} />
        </Panel>
      </div>

      <Panel title={L("Backtest: kalau kamu mengikuti 30 hari terakhir", "Backtest: had you followed for the last 30 days")} aside={<Source kind="live">{L("Replay fill Perpl nyata", "Replay of real Perpl fills")}</Source>}>
        <BacktestPanel perplAddress={l.perplAccount} mandate={{ maxDDbps: l.maxDD * 100, epochLen: l.epochLenH * 3600, maxLeverageHdths: l.maxLeverage * 100 }} />
      </Panel>

      <StrategyFeed book={l.book} leader={l.owner} />

      <Panel title={L("Checkpoint dan pelanggaran", "Checkpoints and breaches")} pad={false} aside={<Source kind="indexer">LeaderBook.Checkpoint / Breached</Source>}>
        {!cps ? (
          <Empty>{L("Indexer tidak merespons. Coba lagi sebentar.", "The indexer did not respond. Try again shortly.")}</Empty>
        ) : !cps.length ? (
          <Empty>{L("Belum ada checkpoint terindeks.", "No checkpoints indexed yet.")}</Empty>
        ) : (
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>{L("Waktu", "Time")}</th>
                <th>Epoch</th>
                <th className="r">{L("Harga unit", "Unit price")}</th>
                <th className="r">Drawdown</th>
                <th className="r">Lev.</th>
                <th>{L("Hasil", "Result")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {cps.map((c, i) => (
                <tr key={i}>
                  <td className="text-ink-3">{ago(c.t)}</td>
                  <td>{c.epoch}</td>
                  <td className="r">{num(c.unitPrice, 4)}</td>
                  <td className={`r ${c.ddPct > l.maxDD ? "text-down" : ""}`}>{pct(c.ddPct, 2)}</td>
                  <td className="r">{num(c.leverage, 1)}x</td>
                  <td>{c.breach ? <span className="text-down">✕ {L("Breach", "Breach")}: {c.breach}</span> : <span className="text-ink-3">✓ OK</span>}</td>
                  <td className="r">
                    {c.tx ? (
                      <a href={explorerTx(c.tx, copasChain.id)} className="text-xs text-ink-3 hover:text-ink-2" target="_blank" rel="noreferrer">
                        tx
                      </a>
                    ) : (
                      c.block > 0 && (
                        <a href={`${copasChain.blockExplorers.default.url}/block/${c.block}`} className="text-xs text-ink-3 hover:text-ink-2" target="_blank" rel="noreferrer">
                          #{c.block}
                        </a>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </Panel>
    </div>
  );
}

async function ShadowProfile({ addr, L }: { addr: string; L: Lx }) {
  const [snap, periods] = await Promise.all([walletSnapshot(addr).catch(() => null), walletPeriods(addr).catch(() => [])]);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href="/?tab=shadow" className="text-sm text-ink-3 hover:text-ink-2">
            {L("Leader bayangan", "Shadow leaders")}
          </Link>
          <h1 className="num mt-1 font-cond text-3xl font-semibold">{short(addr)}</h1>
          <p className="mt-2 max-w-2xl text-sm text-warn">
            {L(
              "Trader Perpl ini belum menaruh jaminan di Copas. Data di bawah nyata, tapi tidak ada mandat dan tidak ada kompensasi bila ia merugi.",
              "This Perpl trader has not posted a Copas bond. The data below is real, but there is no mandate and no compensation if they lose.",
            )}
          </p>
        </div>
        <Link href={`/analytics/wallet/${addr}`} className={btn.ghost}>
          {L("Analitik lengkap", "Full analytics")}
        </Link>
      </div>
      <div className="flex flex-wrap gap-2">
        <AttestedBadge perplAddress={addr} />
        <AlignmentBadge perplAddress={addr} />
      </div>
      <Panel title={L("Kinerja Perpl", "Perpl performance")} aside={<Source kind="live">/trading/leaderboard</Source>}>
        <StatRow>
          {periods.map((p) => (
            <Stat key={p.period} label={`PnL ${p.period === "2weeks" ? "14d" : p.period === "day" ? "24h" : p.period === "week" ? "7d" : p.period === "month" ? "30d" : L("semua", "all")}`} value={usd(p.pnl, { sign: true, compact: true })} tone={(p.pnl ?? 0) >= 0 ? "text-up" : "text-down"} sub={p.roi != null ? `ROI ${pct(p.roi, 1, true)}` : undefined} />
          ))}
          <Stat label="Equity" value={usd(snap?.equity)} />
        </StatRow>
      </Panel>
      <Panel title={L("Posisi terbuka", "Open positions")} pad={false} aside={<Source kind="live">getPosition</Source>}>
        {snap?.positions.length ? (
          <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Market</th>
                <th>{L("Arah", "Side")}</th>
                <th className="r">Notional</th>
                <th className="r">{L("Masuk", "Entry")}</th>
                <th className="r">Lev.</th>
                <th className="r">uPnL</th>
              </tr>
            </thead>
            <tbody>
              {snap.positions.map((p) => (
                <tr key={p.marketId}>
                  <td>{p.market}</td>
                  <td className={p.side === "long" ? "text-up" : "text-down"}>{p.side === "long" ? "Long" : "Short"}</td>
                  <td className="r">{usd(p.notional)}</td>
                  <td className="r">{price(p.entry)}</td>
                  <td className="r">{p.leverage ? `${num(p.leverage, 1)}x` : "–"}</td>
                  <td className={`r ${p.upnl >= 0 ? "text-up" : "text-down"}`}>{usd(p.upnl, { sign: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        ) : (
          <Empty>{snap ? L("Tidak ada posisi terbuka.", "No open positions.") : L("Tidak ada akun Perpl.", "No Perpl account.")}</Empty>
        )}
      </Panel>
      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={L("Backtest dengan aturan Copas, 30 hari", "Backtest under Copas rules, 30 days")} aside={<Source kind="live">@copas/services</Source>}>
          <BacktestPanel perplAddress={addr} />
        </Panel>
        <Panel title={L("Analisis risiko AI", "AI risk analysis")}>
          <AnalysisPanel perplAddress={addr} />
        </Panel>
      </div>
    </div>
  );
}
