"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Abi } from "viem";
import { parseUnits } from "viem";
import { Empty, Panel, PageHead, Source, Stat, StatRow, btn } from "@/components/ui";
import { DDMeter } from "@/components/copas";
import { useL, useT } from "@/lib/i18n/client";
import { useMeraSession } from "@/lib/mera/MeraProvider";
import { useCopasWrite } from "@/lib/copas/useCopasWrite";
import { copasAbi, type Leader } from "@/lib/copas/contracts";
import type { LiveVault } from "@/lib/copas/indexer";
import type { VaultState } from "@/lib/copas/data";
import { ago, num, pct, price, short, usd } from "@/lib/format";
import { copasChain, explorerTx } from "@/lib/chains";

type Fills = { rows: LiveVault["fills"]; src: "indexer" | "rpc" };

export function MeView({ live, chain, leader, fills, query, badQuery }: { live: LiveVault | null; chain: VaultState | null; leader: Leader | null; fills: Fills; query?: string; badQuery?: boolean }) {
  const L = useL();
  const { t } = useT();
  const router = useRouter();
  const { status, address } = useMeraSession();
  const { write, pending, error } = useCopasWrite();
  const [amt, setAmt] = useState("10");
  // the server reads the vault by ?owner=; hand it the signed-in wallet once
  useEffect(() => {
    if (address && !query) router.replace(`/me?owner=${address}`);
  }, [address, query, router]);

  const head = (
    <PageHead title={t("nav.me")} lede={L("Vault milikmu yang menyalin satu leader, dalam batas yang kamu tetapkan.", "Your own vault copying one leader, inside the limits you set.")}>
      {chain && <Source kind="rpc">FollowerVault · Perpl{live ? " + Envio" : ""}</Source>}
    </PageHead>
  );
  if (!chain)
    return (
      <div className="space-y-6">
        {head}
        <Panel>
          <Empty>
            {badQuery
              ? L("Itu bukan alamat 0x (40 karakter hex). ", "That is not a 0x address (40 hex characters). ")
              : query
              ? L(`Belum ada vault untuk ${short(query)}. `, `No vault for ${short(query)} yet. `)
              : status === "signed-in"
                ? L("Membaca vault kamu…", "Reading your vault…")
                : L("Masuk dengan passkey untuk melihat vault kamu. ", "Sign in with your passkey to see your vault. ")}
            {(query || status !== "signed-in") && (
              <Link href="/" className="underline">
                {L("Pilih leader untuk diikuti", "Pick a leader to follow")}
              </Link>
            )}
          </Empty>
        </Panel>
      </div>
    );

  const vault = { address: chain.vault, abi: copasAbi.FollowerVault as Abi };
  // ?vault= can show anyone's vault; only its owner may sign for it
  const isOwner = status === "signed-in" && !!address && address.toLowerCase() === chain.owner.toLowerCase();
  const wd = amt.trim() === "" ? NaN : Number(amt);
  const wdErr = !(wd > 0) ? L("Masukkan jumlah di atas 0.", "Enter an amount above 0.") : wd > chain.equity ? L(`Maksimal ${usd(chain.equity)} (equity vault).`, `At most ${usd(chain.equity)} (vault equity).`) : undefined;
  const pnl = live ? chain.equity - live.netDeposit : null;
  // one row per market where the vault or its leader holds a position
  const mine = new Map(chain.positions.map((p) => [p.marketId, p]));
  const theirs = new Map(chain.leaderPositions.map((p) => [p.marketId, p]));
  const rows = [...new Set([...mine.keys(), ...theirs.keys()])].map((id) => ({ id, me: mine.get(id), ld: theirs.get(id) }));
  const signed = (p?: { side: string; size: number }) => (p ? (p.side === "long" ? p.size : -p.size) : 0);
  const claimable = live ? live.claimable : chain.claimable;

  // vaults from the 12 Oct factory only copy under mandate terms their owner accepted (FollowerVault.consentOk)
  const c = chain.consent;
  const ask = c && (!c.ok ? { m: c.live, why: "lapsed" as const } : c.pending ? { m: c.pending.next, why: "pending" as const } : null);
  const consentPanel = ask && (
    <Panel title={ask.why === "lapsed" ? L("Copy berhenti: leader melonggarkan mandat", "Copying stopped: the leader loosened its mandate") : L(`Leader melonggarkan mandat mulai epoch ${c!.pending!.effectiveEpoch}`, `The leader loosens its mandate from epoch ${c!.pending!.effectiveEpoch}`)} aside={<Source kind="rpc">FollowerVault.consentOk</Source>}>
      <div className="grid gap-1 text-sm sm:grid-cols-2">
        <span className="text-ink-3">{L("Yang kamu setujui", "What you agreed to")}</span>
        <span className="num">DD {c!.accepted.maxDD}% · fee {c!.accepted.feePct}% · {c!.accepted.maxLeverage}x · {c!.accepted.markets.join(", ")}</span>
        <span className="text-ink-3">{L("Syarat baru", "New terms")}</span>
        <span className="num text-warn">DD {ask.m.maxDD}% · fee {ask.m.feePct}% · {ask.m.maxLeverage}x · {ask.m.markets.join(", ")}</span>
      </div>
      <p className="mt-3 text-sm text-ink-2">
        {ask.why === "lapsed"
          ? L("Vault kamu tidak menyalin leader ini (sync menutup posisi) sampai kamu setuju. Fee tetap memakai tarif yang kamu setujui.", "Your vault does not copy this leader (sync unwinds to flat) until you accept. Fees stay at the rate you agreed to.")
          : L("Kalau tidak kamu setujui, vault berhenti menyalin saat epoch berganti. Kamu juga bisa unfollow.", "If you don't accept, your vault stops copying when the epoch rolls. You can also unfollow.")}
      </p>
      <button
        disabled={pending || !isOwner}
        className={btn.primary + " mt-3"}
        onClick={async () => {
          if (await write("risky", { ...vault, functionName: "acceptMandate", args: [ask.m.raw] })) router.refresh();
        }}
      >
        {L("Setujui syarat baru", "Accept the new terms")}
      </button>
    </Panel>
  );

  return (
    <div className="space-y-6">
      {head}
      {consentPanel}
      <Panel
        title={
          <span>
            {L("Vault", "Vault")} <span className="num text-ink-3">{short(chain.vault)}</span>{" "}
            {chain.leader ? (
              <>
                {L("mengikuti", "following")}{" "}
                <Link className="hover:text-gold-2" href={`/leader/${chain.leader}`}>
                  {leader?.name ?? short(chain.leader)}
                </Link>
              </>
            ) : (
              L("belum mengikuti leader", "not following a leader")
            )}
          </span>
        }
        aside={<span className="num">{L("pemilik", "owner")} {short(chain.owner)}</span>}
      >
        <StatRow>
          <Stat label="Equity" value={usd(chain.equity)} sub={live ? `${L("setoran bersih", "net deposit")} ${usd(live.netDeposit)}` : undefined} />
          {pnl != null && <Stat label="PnL" value={usd(pnl, { sign: true })} sub={live?.netDeposit ? pct((pnl / live.netDeposit) * 100, 2, true) : undefined} tone={pnl >= 0 ? "text-up" : "text-down"} />}
          <Stat label="HWM" value={usd(chain.hwm)} sub={L("dasar fee kinerja", "performance fee base")} />
          {leader && <Stat label={L("Drawdown leader", "Leader drawdown")} value={<DDMeter live={leader.liveDD} max={leader.maxDD} />} />}
          <Stat label={L("Rasio / lev. maks", "Ratio / max lev.")} value={`${pct(chain.params.ratioPct, 1)} / ${chain.params.maxLeverage}x`} />
          <Stat label={L("Stop-loss vault", "Vault stop-loss")} value={pct(chain.params.stopLossPct, 0)} sub={chain.paused ? L("Dijeda", "Paused") : L("Aktif", "Active")} />
          {live && <Stat label={L("Fee dibayar", "Fees paid")} value={usd(live.feesPaid)} />}
          {live && <Stat label={L("Kompensasi diterima", "Compensation received")} value={usd(live.slashReceived)} tone={live.slashReceived > 0 ? "text-gold-2" : ""} />}
        </StatRow>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel className="lg:col-span-2" title={L("Posisi tersalin", "Copied positions")} pad={false} aside={<Source kind="rpc">Perpl getPosition</Source>}>
          {rows.length ? (
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th className="r">{L("Ukuranmu", "Your size")}</th>
                    <th className="r">{L("Ukuran leader", "Leader size")}</th>
                    <th className="r">{L("Masuk", "Entry")}</th>
                    <th className="r">Mark</th>
                    <th className="r">uPnL</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ id, me, ld }) => (
                    <tr key={id}>
                      <td>{(me ?? ld)!.market}</td>
                      <td className={`r ${signed(me) > 0 ? "text-up" : signed(me) < 0 ? "text-down" : "text-ink-3"}`}>{num(signed(me), 4)}</td>
                      <td className="r text-ink-3">{num(signed(ld), 4)}</td>
                      <td className="r">{me ? price(me.entry) : "–"}</td>
                      <td className="r">{price((me ?? ld)!.mark)}</td>
                      <td className={`r ${(me?.upnl ?? 0) >= 0 ? "text-up" : "text-down"}`}>{me ? usd(me.upnl, { sign: true }) : "–"}</td>
                      <td className="r">
                        <button disabled={pending} onClick={() => write("small", { ...vault, functionName: "sync", args: [BigInt(id)] })} className="text-xs text-ink-3 hover:text-gold-2 disabled:opacity-50">
                          sync
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>{chain.leader ? L("Kamu dan leader tidak punya posisi terbuka.", "Neither you nor the leader has an open position.") : L("Tidak ada posisi terbuka.", "No open positions.")}</Empty>
          )}
          <p className="px-4 py-3 text-xs text-ink-3">{L("sync bisa dipanggil siapa saja dan hanya menggerakkan posisimu menuju rasio × posisi leader. Tanpa prompt selama sesi aktif.", "Anyone can call sync, and it only moves your position toward ratio × the leader's. No prompt while your session is live.")}</p>
        </Panel>

        <div className="space-y-6">
          <Panel title={L("Klaim kompensasi", "Claim compensation")} aside={<Source kind={live ? "indexer" : "rpc"}>{live ? "Breach / Claim" : "LeaderBook.breachOf"}</Source>}>
            {!claimable.length && !live?.claims.length && <p className="text-sm text-ink-3">{L("Tidak ada breach pada leader yang kamu ikuti.", "No breaches on the leaders you follow.")}</p>}
            {claimable.map((c) => (
              <div key={c.book + c.epoch} className="space-y-2 text-sm">
                <p className="text-ink-2">{L(`${short(c.book)} melanggar mandat di epoch ${c.epoch}.`, `${short(c.book)} broke its mandate in epoch ${c.epoch}.`)}</p>
                <div className="flex justify-between">
                  <span className="text-ink-3">{L("Estimasi klaim maks", "Max estimated claim")}</span>
                  <span className="num text-gold-2">{usd(c.estimate)}</span>
                </div>
                <button disabled={pending || !isOwner} className={btn.primary + " w-full"} onClick={() => write("small", { ...vault, functionName: "claim", args: [c.book, BigInt(c.epoch)] })}>
                  {L("Klaim ke vault", "Claim to vault")}
                </button>
                <p className="text-xs text-ink-3">{L("klaim = min(jaminan × cap kamu / Σcap, kerugian nyata)", "claim = min(slash × your cap / Σcap, actual loss)")}</p>
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
          </Panel>
          <Panel title={L("Tarik dana", "Withdraw")}>
            <label className="text-sm text-ink-2" htmlFor="wd">
              {L("Jumlah (AUSD)", "Amount (AUSD)")}
            </label>
            <input
              id="wd"
              type="number"
              inputMode="decimal"
              min={0}
              max={chain.equity}
              step="any"
              value={amt}
              onChange={(e) => setAmt(e.target.value)}
              aria-invalid={!!wdErr}
              aria-describedby={wdErr ? "wd-err" : undefined}
              disabled={!isOwner}
              className="num mt-1 w-full rounded-md border border-line-strong bg-bg px-3 py-2 text-sm disabled:opacity-50"
            />
            {wdErr && isOwner && (
              <p id="wd-err" className="mt-1 text-xs text-down">
                {wdErr}
              </p>
            )}
            <button
              disabled={pending || !!wdErr || !isOwner}
              className={btn.ghost + " mt-3 w-full"}
              onClick={() => write("risky", { ...vault, functionName: "withdraw", args: [parseUnits(Math.min(wd, chain.equity).toFixed(6), 6)] })}
            >
              {L("Tarik ke alamatku", "Withdraw to my address")}
            </button>
            <p className="mt-2 text-xs text-ink-3">
              {isOwner
                ? L("Penarikan selalu meminta passkey dan hanya bisa ke pemilik vault.", "Withdrawals always ask for your passkey and only go to the vault owner.")
                : L(`Hanya pemilik vault (${short(chain.owner)}) yang bisa menarik atau mengklaim. Masuk dengan passkey pemilik.`, `Only the vault owner (${short(chain.owner)}) can withdraw or claim. Sign in with the owner's passkey.`)}
            </p>
          </Panel>
          {error === "contracts-not-deployed" && <p role="alert" className="text-sm text-warn">{L("Kontrak belum di-deploy; aksi ini aktif setelah deploy.", "Contracts are not deployed yet; this action goes live after deployment.")}</p>}
          {error && error !== "contracts-not-deployed" && <p role="alert" className="text-sm text-down">{error}</p>}
        </div>
      </div>

      <Panel title={L("Bukti eksekusi per copy", "Execution proof per copy")} pad={false} aside={<Source kind={fills.src}>{fills.src === "indexer" ? "Envio CopyFill" : "FollowerVault.Synced"}</Source>}>
        {fills.rows.length ? (
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
                {fills.rows.map((f) => (
                  <tr key={f.tx + f.market}>
                    <td className="text-ink-3">{ago(f.t)}</td>
                    <td>
                      {f.market}{" "}
                      <span className={f.target > 0 ? "text-up" : f.target < 0 ? "text-down" : "text-ink-3"} title={L("Sisi posisimu setelah copy", "Your side after the copy")}>
                        {f.target > 0 ? "L" : f.target < 0 ? "S" : L("tutup", "flat")}
                      </span>
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
          <Empty>{fills.src === "indexer" ? L("Belum ada copy yang tersinkron.", "No synced copies yet.") : L("Tidak ada sync dalam ~1000 blok terakhir (indexer tidak tersedia untuk riwayat penuh).", "No syncs in the last ~1000 blocks (indexer unavailable for full history).")}</Empty>
        )}
      </Panel>
    </div>
  );
}
