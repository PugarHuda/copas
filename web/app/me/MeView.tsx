"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Abi } from "viem";
import { parseUnits } from "viem";
import { Panel, PageHead, Source, Stat, StatRow, btn } from "@/components/ui";
import { DDMeter } from "@/components/copas";
import { useL, useT } from "@/lib/i18n/client";
import { useMeraSession } from "@/lib/mera/MeraProvider";
import { useCopasWrite } from "@/lib/copas/useCopasWrite";
import { copasAbi } from "@/lib/copas/contracts";
import { MOCK_VAULT } from "@/lib/mock/copas"; // fallback when the indexer has no vault for this owner
import type { LiveVault } from "@/lib/copas/indexer";
import { ago, num, pct, price, short, usd } from "@/lib/format";
import { copasChain, explorerTx } from "@/lib/chains";

const NOW = Date.UTC(2026, 9, 4, 3);

export function MeView({ live, query }: { live: LiveVault | null; query?: string }) {
  const L = useL();
  const { t } = useT();
  const router = useRouter();
  const { status, address } = useMeraSession();
  const { write, pending, error } = useCopasWrite();
  const [amt, setAmt] = useState(10);
  const v = MOCK_VAULT;
  const vault = { address: live?.vault ?? v.vault, abi: copasAbi.FollowerVault as Abi };
  const pnl = v.equity - v.deposited;
  // the server reads the vault by ?owner=; hand it the signed-in wallet once
  useEffect(() => {
    if (address && !query) router.replace(`/me?owner=${address}`);
  }, [address, query, router]);

  return (
    <div className="space-y-6">
      <PageHead title={t("nav.me")} lede={L("Vault milikmu yang menyalin satu leader, dalam batas yang kamu tetapkan.", "Your own vault copying one leader, inside the limits you set.")}>
        <Source kind={live ? "indexer" : "mock"}>{live ? "Vault / Follower / CopyFill / Claim" : t("common.mockNote")}</Source>
      </PageHead>
      {!live && query && <p className="rounded-lg border border-line bg-surface p-4 text-sm text-ink-2">{L(`Belum ada vault terindeks untuk ${short(query)}. Di bawah ini contoh tampilan.`, `No indexed vault for ${short(query)} yet. Below is an example.`)}</p>}
      {!live && !query && status !== "signed-in" && <p className="rounded-lg border border-line bg-surface p-4 text-sm text-ink-2">{L("Masuk dengan passkey untuk melihat vault kamu. Di bawah ini contoh tampilan.", "Sign in with your passkey to see your vault. Below is an example.")}</p>}

      {live ? (
        <Panel
          title={
            <span>
              {L("Vault", "Vault")} <span className="num text-ink-3">{short(live.vault)}</span>{" "}
              {live.leader ? (
                <>
                  {L("mengikuti", "following")}{" "}
                  <Link className="hover:text-gold-2" href={`/leader/${live.leader}`}>
                    {short(live.leader)}
                  </Link>
                </>
              ) : (
                L("belum mengikuti leader", "not following a leader")
              )}
            </span>
          }
          aside={<span className="num">{L("pemilik", "owner")} {short(live.owner)}</span>}
        >
          <StatRow>
            <Stat label={L("Setoran bersih", "Net deposit")} value={usd(live.netDeposit)} />
            <Stat label={L("Fee dibayar", "Fees paid")} value={usd(live.feesPaid)} />
            <Stat label={L("Kompensasi diterima", "Compensation received")} value={usd(live.slashReceived)} tone={live.slashReceived > 0 ? "text-gold-2" : ""} />
            <Stat label={L("Drawdown leader", "Leader drawdown")} value={<DDMeter live={live.leaderDD} max={live.leaderMaxDD} />} />
            <Stat label={L("Rasio / lev. maks", "Ratio / max lev.")} value={live.params ? `${pct(live.params.ratioPct, 1)} / ${live.params.maxLeverage}x` : "–"} />
            <Stat label={L("Stop-loss vault", "Vault stop-loss")} value={live.params ? pct(live.params.stopLossPct, 0) : "–"} sub={live.paused ? L("Dijeda", "Paused") : L("Aktif", "Active")} />
          </StatRow>
        </Panel>
      ) : (
      <Panel
        title={
          <span>
            {L("Vault", "Vault")} <span className="num text-ink-3">{short(v.vault)}</span> {L("mengikuti", "following")}{" "}
            <Link className="hover:text-gold-2" href={`/leader/${v.leader.book}`}>
              {v.leader.name}
            </Link>
          </span>
        }
        aside={address && <span className="num">{L("pemilik", "owner")} {short(address)}</span>}
      >
        <StatRow>
          <Stat label="Equity" value={usd(v.equity)} />
          <Stat label="PnL" value={usd(pnl, { sign: true })} sub={pct((pnl / v.deposited) * 100, 2, true)} tone={pnl >= 0 ? "text-up" : "text-down"} />
          <Stat label="HWM" value={usd(v.hwm)} sub={L("dasar fee kinerja", "performance fee base")} />
          <Stat label={L("Drawdown leader", "Leader drawdown")} value={<DDMeter live={v.leader.liveDD} max={v.leader.maxDD} />} />
          <Stat label={L("Rasio / lev. maks", "Ratio / max lev.")} value={`${pct(v.params.ratioPct, 1)} / ${v.params.maxLeverage}x`} />
          <Stat label={L("Stop-loss vault", "Vault stop-loss")} value={pct(v.params.stopLossPct, 0)} sub={v.paused ? L("Dijeda", "Paused") : L("Aktif", "Active")} />
        </StatRow>
      </Panel>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel className="lg:col-span-2" title={L("Posisi tersalin", "Copied positions")} pad={false} aside={live && <Source kind="mock">{L("Demo", "Demo")}</Source>}>
          <table className="data">
            <thead>
              <tr>
                <th>Market</th>
                <th>{L("Arah", "Side")}</th>
                <th className="r">{L("Ukuranmu", "Your size")}</th>
                <th className="r">{L("Ukuran leader", "Leader size")}</th>
                <th className="r">{L("Masuk", "Entry")}</th>
                <th className="r">Mark</th>
                <th className="r">uPnL</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {v.positions.map((p) => (
                <tr key={p.market}>
                  <td>{p.market}</td>
                  <td className={p.side === "long" ? "text-up" : "text-down"}>{p.side === "long" ? "Long" : "Short"}</td>
                  <td className="r">{num(p.size, 4)}</td>
                  <td className="r text-ink-3">{num(p.leaderSize, 3)}</td>
                  <td className="r">{price(p.entry)}</td>
                  <td className="r">{price(p.mark)}</td>
                  <td className={`r ${p.upnl >= 0 ? "text-up" : "text-down"}`}>{usd(p.upnl, { sign: true })}</td>
                  <td className="r">
                    <button disabled={pending} onClick={() => write("small", { ...vault, functionName: "sync", args: [p.market === "BTC" ? 1n : 31n] })} className="text-xs text-ink-3 hover:text-gold-2">
                      sync
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-3 text-xs text-ink-3">{L("sync bisa dipanggil siapa saja dan hanya menggerakkan posisimu menuju rasio × posisi leader. Tanpa prompt selama sesi aktif.", "Anyone can call sync, and it only moves your position toward ratio × the leader's. No prompt while your session is live.")}</p>
        </Panel>

        <div className="space-y-6">
          <Panel title={L("Klaim kompensasi", "Claim compensation")} aside={live && <Source kind="indexer">Breach / Claim</Source>}>
            {live && !live.claimable.length && !live.claims.length && <p className="text-sm text-ink-3">{L("Tidak ada breach pada leader yang kamu ikuti.", "No breaches on the leaders you follow.")}</p>}
            {live?.claimable.map((c) => (
              <div key={c.book + c.epoch} className="space-y-2 text-sm">
                <p className="text-ink-2">{L(`${short(c.book)} melanggar mandat di epoch ${c.epoch}.`, `${short(c.book)} broke its mandate in epoch ${c.epoch}.`)}</p>
                <div className="flex justify-between">
                  <span className="text-ink-3">{L("Estimasi klaim maks", "Max estimated claim")}</span>
                  <span className="num text-gold-2">{usd(c.estimate)}</span>
                </div>
                <button disabled={pending} className={btn.primary + " w-full"} onClick={() => write("small", { ...vault, functionName: "claim", args: [c.book, BigInt(c.epoch)] })}>
                  {L("Klaim ke vault", "Claim to vault")}
                </button>
              </div>
            ))}
            {live?.claims.map((c) => (
              <div key={c.tx} className="flex justify-between text-sm">
                <span className="text-ink-3">
                  {short(c.book)} · epoch {c.epoch}
                </span>
                <a className="num text-up hover:text-gold-2" href={explorerTx(c.tx, copasChain.id)} target="_blank" rel="noreferrer">
                  {usd(c.amount)} {L("diklaim", "claimed")}
                </a>
              </div>
            ))}
            {!live && v.claimable.map((c) => (
              <div key={c.leader.book + c.epoch} className="space-y-2 text-sm">
                <p className="text-ink-2">
                  {L(`${c.leader.name} melanggar mandat di epoch ${c.epoch}.`, `${c.leader.name} broke its mandate in epoch ${c.epoch}.`)}
                </p>
                <div className="flex justify-between">
                  <span className="text-ink-3">{L("Kerugianmu", "Your loss")}</span>
                  <span className="num">{usd(c.loss)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-3">{L("Estimasi klaim", "Estimated claim")}</span>
                  <span className="num text-gold-2">{usd(c.estimate)}</span>
                </div>
                <button disabled={pending} className={btn.primary + " w-full"} onClick={() => write("small", { ...vault, functionName: "claim", args: [c.leader.book, BigInt(c.epoch)] })}>
                  {L("Klaim ke vault", "Claim to vault")}
                </button>
                <p className="text-xs text-ink-3">{L("klaim = min(jaminan × cap kamu / Σcap, kerugian nyata)", "claim = min(slash × your cap / Σcap, actual loss)")}</p>
              </div>
            ))}
          </Panel>
          <Panel title={L("Tarik dana", "Withdraw")}>
            <label className="text-sm text-ink-2" htmlFor="wd">
              {L("Jumlah (AUSD)", "Amount (AUSD)")}
            </label>
            <input id="wd" type="number" min={1} max={v.equity} value={amt} onChange={(e) => setAmt(Number(e.target.value))} className="num mt-1 w-full rounded-md border border-line-strong bg-bg px-3 py-2 text-sm" />
            <button disabled={pending || amt <= 0} className={btn.ghost + " mt-3 w-full"} onClick={() => write("risky", { ...vault, functionName: "withdraw", args: [parseUnits(String(amt), 6)] })}>
              {L("Tarik ke alamatku", "Withdraw to my address")}
            </button>
            <p className="mt-2 text-xs text-ink-3">{L("Penarikan selalu meminta passkey dan hanya bisa ke pemilik vault.", "Withdrawals always ask for your passkey and only go to the vault owner.")}</p>
          </Panel>
          {error === "contracts-not-deployed" && <p role="alert" className="text-sm text-warn">{L("Kontrak belum di-deploy; aksi ini aktif setelah deploy.", "Contracts are not deployed yet; this action goes live after deployment.")}</p>}
          {error && error !== "contracts-not-deployed" && <p role="alert" className="text-sm text-down">{error}</p>}
        </div>
      </div>

      {live ? (
        <Panel title={L("Bukti eksekusi per copy", "Execution proof per copy")} pad={false} aside={<Source kind="indexer">Envio CopyFill</Source>}>
          {live.fills.length ? (
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>{L("Waktu", "Time")}</th>
                    <th>Market</th>
                    <th className="r">{L("Posisi leader", "Leader position")}</th>
                    <th className="r">{L("Posisimu: dari → target", "Yours: from → target")}</th>
                    <th className="r">Mark</th>
                    <th className="r">{L("Blok", "Block")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {live.fills.map((f) => (
                    <tr key={f.tx + f.market}>
                      <td className="text-ink-3">{ago(f.t)}</td>
                      <td>
                        {f.market} <span className={f.target >= f.from ? "text-up" : "text-down"}>{f.target >= f.from ? "B" : "S"}</span>
                      </td>
                      <td className="r text-ink-3">{num(f.leaderLot, 4)}</td>
                      <td className="r">
                        {num(f.from, 4)} → {num(f.target, 4)}
                      </td>
                      <td className="r">{price(f.mark)}</td>
                      <td className="r text-ink-3">{f.block}</td>
                      <td className="r">
                        <a className="text-xs text-ink-3 hover:text-ink-2" href={explorerTx(f.tx, copasChain.id)} target="_blank" rel="noreferrer">
                          tx
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="px-4 py-8 text-center text-sm text-ink-3">{L("Belum ada copy yang tersinkron.", "No synced copies yet.")}</p>
          )}
        </Panel>
      ) : (
      <Panel title={L("Bukti eksekusi per copy", "Execution proof per copy")} pad={false} aside={<Source kind="mock">Envio CopyFill</Source>}>
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>{L("Waktu", "Time")}</th>
                <th>Market</th>
                <th className="r">{L("Harga leader", "Leader price")}</th>
                <th className="r">{L("Harga kamu", "Your price")}</th>
                <th className="r">Slippage</th>
                <th className="r">Fee</th>
                <th className="r">Funding</th>
                <th className="r">{L("Jeda", "Lag")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {v.fills.map((f) => (
                <tr key={f.tx}>
                  <td className="text-ink-3">{ago(f.t, NOW)}</td>
                  <td>
                    {f.market} <span className={f.side === "long" ? "text-up" : "text-down"}>{f.side === "long" ? "L" : "S"}</span>
                  </td>
                  <td className="r">{price(f.leaderPx)}</td>
                  <td className="r">{price(f.followerPx)}</td>
                  <td className={`r ${f.slipBps > 15 ? "text-warn" : ""}`}>{num(f.slipBps, 1)} bp</td>
                  <td className="r">{usd(f.fee, { dp: 3 })}</td>
                  <td className="r">{usd(f.funding, { dp: 3, sign: true })}</td>
                  <td className="r">{f.blocks} {L("blok", "blocks")}</td>
                  <td className="r">
                    <a className="text-xs text-ink-3 hover:text-ink-2" href={explorerTx(f.tx)} target="_blank" rel="noreferrer">
                      tx
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      )}
    </div>
  );
}
