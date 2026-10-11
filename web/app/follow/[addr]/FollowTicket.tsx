"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { encodeFunctionData, erc20Abi, parseUnits, type Abi } from "viem";
import { useL, useT } from "@/lib/i18n/client";
import { useMeraSession } from "@/lib/mera/MeraProvider";
import { copasPublic, useCopasWrite } from "@/lib/copas/useCopasWrite";
import { copasAbi, deployment, isDeployed, marketsMask } from "@/lib/copas/contracts";
import { getReferrer } from "@/lib/copas/referral";
import type { Leader } from "@/lib/mock/copas";
import { num, pct, usd } from "@/lib/format";
import { Panel, btn } from "@/components/ui";
import { AnalysisPanel, BacktestPanel, SimulatePreview, type FollowerSettings } from "@/components/services";
import { copasChain } from "@/lib/chains";

const MAINNET_CAP = 100;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-3">{hint}</span>}
    </label>
  );
}
const input = "num mt-1 w-full rounded-md border border-line-strong bg-bg px-3 py-2 text-sm focus:border-gold focus:outline-none";

export function FollowTicket({ leader: l }: { leader: Leader }) {
  const L = useL();
  const { t } = useT();
  const { status, address } = useMeraSession();
  const { write, pending, error } = useCopasWrite();
  const [deposit, setDeposit] = useState(100);
  const [ratio, setRatio] = useState(2);
  const [maxNotional, setMaxNotional] = useState(300);
  const [maxLev, setMaxLev] = useState(Math.min(5, l.maxLeverage));
  const [chase, setChase] = useState(100);
  const [band, setBand] = useState(50);
  const [stop, setStop] = useState(20);
  const [mkts, setMkts] = useState<string[]>(l.markets);
  const [ack, setAck] = useState(false);
  const [done, setDone] = useState<string>();

  // Debounced settings for the backtest so typing does not fire a replay per keystroke.
  const settings: FollowerSettings = { depositCNS: deposit, ratioBps: Math.round(ratio * 100), maxNotionalCNS: maxNotional, maxLeverageHdths: Math.round(maxLev * 100), maxChaseBps: chase, priceBandBps: band, stopLossBps: Math.round(stop * 100) };
  const [bt, setBt] = useState(settings);
  const key = JSON.stringify(settings);
  useEffect(() => {
    const id = setTimeout(() => setBt(JSON.parse(key)), 700);
    return () => clearTimeout(id);
  }, [key]);

  const prot = l.followerAum + deposit > 0 ? Math.min(100, ((l.bond + l.underwritten) / (l.followerAum + deposit)) * 100) : 100;
  const example = 10_000;
  const copied = Math.min(example * (ratio / 100), maxNotional);
  const overCap = deposit > MAINNET_CAP;
  const invalid = overCap || deposit < 10 || ratio <= 0 || !mkts.length;

  const params = useMemo(
    () => ({
      ratioBps: Math.round(ratio * 100),
      maxLeverageHdths: Math.round(maxLev * 100),
      maxChaseBps: chase,
      priceBandBps: band,
      stopLossBps: Math.round(stop * 100),
      maxNotionalCNS: parseUnits(String(maxNotional), 6),
      marketsMask: marketsMask(mkts),
    }),
    [ratio, maxLev, chase, band, stop, maxNotional, mkts],
  );

  async function submit() {
    if (!isDeployed || !deployment?.registry || !deployment.ausd) return write("risky", {} as never);
    const reg = { address: deployment.registry, abi: copasAbi.CopasRegistry as Abi };
    // risky: one fresh passkey prompt; the follow-up calls sign inside the renewed session
    if (!(await write("risky", { ...reg, functionName: "createVault" }))) return;
    const vaults = (await copasPublic.readContract({ ...reg, functionName: "vaultsOf", args: [address] })) as `0x${string}`[];
    const vault = vaults[vaults.length - 1];
    const v = { address: vault, abi: copasAbi.FollowerVault as Abi };
    const amt = parseUnits(String(deposit), 6);
    await write("small", { address: deployment.ausd, abi: erc20Abi as Abi, functionName: "approve", args: [vault, amt] });
    await write("small", { ...v, functionName: "deposit", args: [amt] });
    const ref = getReferrer();
    if (ref && ref.toLowerCase() !== address?.toLowerCase()) await write("small", { ...v, functionName: "setReferrer", args: [ref] });
    if (await write("small", { ...v, functionName: "follow", args: [l.book, params] })) setDone(vault);
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
      <div className="space-y-6">
        <Panel title={L("Setelan copy", "Copy settings")}>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={L("Setoran (AUSD)", "Deposit (AUSD)")} hint={L(`Mainnet dibatasi ${MAINNET_CAP} AUSD per vault sampai audit.`, `Mainnet is capped at ${MAINNET_CAP} AUSD per vault until audited.`)}>
              <input type="number" min={10} max={MAINNET_CAP} step={1} value={deposit} onChange={(e) => setDeposit(Number(e.target.value))} className={input} aria-invalid={overCap} />
            </Field>
            <Field label={L("Rasio copy (% dari ukuran leader)", "Copy ratio (% of leader size)")} hint={L(`Leader buka $${example.toLocaleString()} → kamu buka ${usd(copied, { dp: 0 })}.`, `Leader opens $${example.toLocaleString()} → you open ${usd(copied, { dp: 0 })}.`)}>
              <input type="number" min={0.1} max={100} step={0.1} value={ratio} onChange={(e) => setRatio(Number(e.target.value))} className={input} />
            </Field>
            <Field label={L("Notional maks per posisi (AUSD)", "Max notional per position (AUSD)")}>
              <input type="number" min={10} step={10} value={maxNotional} onChange={(e) => setMaxNotional(Number(e.target.value))} className={input} />
            </Field>
            <Field label={L("Leverage maks", "Max leverage")} hint={L(`Mandat leader: ${l.maxLeverage}x.`, `Leader mandate: ${l.maxLeverage}x.`)}>
              <input type="number" min={1} max={l.maxLeverage} step={0.5} value={maxLev} onChange={(e) => setMaxLev(Number(e.target.value))} className={input} />
            </Field>
            <Field label={L("Batas kejar harga (bps)", "Max chase (bps)")} hint={L("Lewati penambahan posisi bila harga sudah bergerak sejauh ini dari harga masuk leader.", "Skip adding when price has moved this far from the leader's entry.")}>
              <input type="number" min={0} step={5} value={chase} onChange={(e) => setChase(Number(e.target.value))} className={input} />
            </Field>
            <Field label={L("Stop-loss vault (%)", "Vault stop-loss (%)")} hint={L("Berhenti menyalin dan tutup posisi bila vault turun sejauh ini dalam satu epoch.", "Stop copying and close out if the vault falls this far within an epoch.")}>
              <input type="number" min={0} max={90} step={1} value={stop} onChange={(e) => setStop(Number(e.target.value))} className={input} />
            </Field>
            <Field label={L("Pita harga IOC (bps)", "IOC price band (bps)")}>
              <input type="number" min={5} step={5} value={band} onChange={(e) => setBand(Number(e.target.value))} className={input} />
            </Field>
            <fieldset>
              <legend className="text-sm text-ink-2">{L("Market yang disalin", "Markets to copy")}</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {l.markets.map((m) => (
                  <label key={m} className={`cursor-pointer rounded border px-2.5 py-1 text-sm ${mkts.includes(m) ? "border-gold text-ink" : "border-line-strong text-ink-3"}`}>
                    <input type="checkbox" className="sr-only" checked={mkts.includes(m)} onChange={(e) => setMkts(e.target.checked ? [...mkts, m] : mkts.filter((x) => x !== m))} />
                    {m}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        </Panel>

        <Panel title={L("Backtest dengan setelan ini, 30 hari", "Backtest with these settings, 30 days")}>
          <BacktestPanel perplAddress={l.perplAccount} follower={bt} mandate={{ maxDDbps: l.maxDD * 100, epochLen: l.epochLenH * 3600, maxLeverageHdths: l.maxLeverage * 100 }} />
        </Panel>

        <Panel title={L("Sebelum kamu ikut: argumen tandingan", "Before you follow: the case against")} aside={<span>Kimi K3</span>}>
          <AnalysisPanel perplAddress={l.perplAccount} />
        </Panel>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        <Panel title={L("Ringkasan", "Summary")}>
          <dl className="space-y-2 text-sm">
            {[
              [L("Setoran", "Deposit"), usd(deposit, { dp: 0 })],
              [L("Rasio", "Ratio"), pct(ratio, 1)],
              [L("Leverage maks", "Max leverage"), `${num(maxLev, 1)}x`],
              [L("Stop-loss vault", "Vault stop-loss"), pct(stop, 0)],
              [L("Fee kinerja leader", "Leader performance fee"), `${l.feePct}% ${L("di atas HWM", "above HWM")}`],
              [L("Fee taker Perpl", "Perpl taker fee"), "3.45 bp"],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4">
                <dt className="text-ink-3">{k}</dt>
                <dd className="num">{v}</dd>
              </div>
            ))}
            <div className="flex justify-between gap-4 border-t border-line pt-2">
              <dt className="text-ink-3">{L("Perlindungan maks setelah kamu masuk", "Max protection after you join")}</dt>
              <dd className={`num ${prot < 25 ? "text-warn" : "text-gold-2"}`}>{pct(prot, 0)}</dd>
            </div>
          </dl>
        </Panel>

        <section className="rounded-lg border border-warn/40 bg-surface p-4 text-sm" aria-labelledby="risk-h">
          <h2 id="risk-h" className="font-medium text-warn">
            {t("risk.title")}
          </h2>
          <ul className="mt-2 list-disc space-y-1.5 pl-5 text-ink-2">
            <li>
              {t("risk.body1")} {L(`Saat ini: ${usd(l.bond + l.underwritten, { dp: 0 })} untuk AUM ${usd(l.followerAum + deposit, { dp: 0 })}.`, `Right now: ${usd(l.bond + l.underwritten, { dp: 0 })} against ${usd(l.followerAum + deposit, { dp: 0 })} AUM.`)}
            </li>
            <li>{t("risk.body2")}</li>
            <li>{L("Fill kamu bisa lebih buruk dari leader: order IOC taker, jeda 1 sampai 3 blok.", "Your fills can be worse than the leader's: taker IOC orders, 1 to 3 blocks behind.")}</li>
            <li>{t("risk.body3")}</li>
            <li>{L("Dana ada di vault milikmu. Hanya kamu yang bisa menarik, dan hanya ke alamatmu.", "Funds sit in a vault you own. Only you can withdraw, and only to your address.")}</li>
          </ul>
          <label className="mt-3 flex items-start gap-2 text-ink">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1 accent-[var(--gold)]" />
            {L("Saya mengerti batas perlindungan ini.", "I understand these limits on protection.")}
          </label>
        </section>

        {status !== "signed-in" ? (
          <p className="rounded-lg border border-line bg-surface p-4 text-sm text-ink-2">{L("Masuk dengan passkey untuk membuat vault dan mengikuti.", "Sign in with your passkey to create a vault and follow.")}</p>
        ) : (
          <button className={btn.primary + " w-full py-3"} disabled={!ack || invalid || pending || l.status !== "active"} onClick={submit}>
            {pending ? L("Menunggu passkey…", "Waiting for passkey…") : L(`Ikuti ${l.name} dengan ${deposit} AUSD`, `Follow ${l.name} with ${deposit} AUSD`)}
          </button>
        )}
        <p className="text-xs text-ink-3">{L("Mengikuti leader baru selalu meminta passkey lagi.", "Following a new leader always asks for your passkey again.")}</p>
        <Panel title={L("Pratinjau transaksi", "Transaction preview")}>
          <SimulatePreview
            tx={
              isDeployed && address && deployment?.registry
                ? { from: address, to: deployment.registry, data: encodeFunctionData({ abi: copasAbi.CopasRegistry as Abi, functionName: "createVault" }), chainId: copasChain.id }
                : undefined
            }
          />
        </Panel>
        {error === "contracts-not-deployed" && <p role="alert" className="text-sm text-warn">{L("Kontrak Copas belum di-deploy di jaringan ini. Setelan sudah valid; transaksi bisa dikirim setelah deploy.", "Copas contracts are not deployed on this network yet. Your settings are valid; the transaction can be sent after deployment.")}</p>}
        {error && error !== "contracts-not-deployed" && <p role="alert" className="text-sm text-down">{error}</p>}
        {done && (
          <p className="text-sm text-up">
            {L("Vault aktif.", "Vault active.")} <Link href="/me" className="underline">{t("nav.me")}</Link>
          </p>
        )}
      </aside>
    </div>
  );
}
