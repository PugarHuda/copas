"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { encodeFunctionData, erc20Abi, parseUnits, type Abi } from "viem";
import { useL, useT } from "@/lib/i18n/client";
import { useMeraSession } from "@/lib/mera/MeraProvider";
import { copasPublic, useCopasWrite } from "@/lib/copas/useCopasWrite";
import { copasAbi, deployment, isDeployed, marketsMask, type Leader } from "@/lib/copas/contracts";
import { getReferrer } from "@/lib/copas/referral";
import { num, pct, usd } from "@/lib/format";
import { Panel, btn } from "@/components/ui";
import { AnalysisPanel, BacktestPanel, SimulatePreview, type FollowerSettings } from "@/components/services";
import { copasChain } from "@/lib/chains";

const MIN_DEPOSIT = 10;
const input = "num mt-1 w-full rounded-md border border-line-strong bg-bg px-3 py-2 text-sm focus:border-gold focus:outline-none aria-[invalid=true]:border-down";

/** Number input with its hint and error wired through aria-describedby (not nested in the label). */
function Field({ id, label, hint, error, ...p }: { id: string; label: string; hint?: string; error?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const desc = [hint && `${id}-hint`, error && `${id}-err`].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={id} className="text-sm text-ink-2">
        {label}
      </label>
      <input id={id} type="number" inputMode="decimal" className={input} aria-invalid={!!error} aria-describedby={desc} {...p} />
      {hint && <p id={`${id}-hint`} className="mt-1 text-xs text-ink-3">{hint}</p>}
      {error && <p id={`${id}-err`} className="mt-1 text-xs text-down">{error}</p>}
    </div>
  );
}

type Form = { deposit: string; ratio: string; maxNotional: string; maxLev: string; chase: string; band: string; stop: string };
const toUnits = (v: number) => parseUnits(v.toFixed(6), 6); // String(1e-7) is not a decimal parseUnits accepts

export function FollowTicket({ leader: l, maxDeposit }: { leader: Leader; maxDeposit: number | null }) {
  const L = useL();
  const { t } = useT();
  const { status, address } = useMeraSession();
  const { write, pending, error } = useCopasWrite();
  const cap = maxDeposit || null; // 0 on chain = no cap
  const [f, setF] = useState<Form>({ deposit: String(cap && cap < 100 ? cap : 100), ratio: "2", maxNotional: "300", maxLev: String(Math.min(5, l.maxLeverage)), chase: "100", band: "50", stop: "20" });
  const on = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const [mkts, setMkts] = useState<string[]>(l.markets);
  const [ack, setAck] = useState(false);
  const [done, setDone] = useState<string>();

  // empty reads as NaN so every check below fails closed
  const n = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim() === "" ? NaN : Number(v)])) as Record<keyof Form, number>;
  const err: Partial<Record<keyof Form, string>> = {};
  if (!(n.deposit >= MIN_DEPOSIT)) err.deposit = L(`Minimal ${MIN_DEPOSIT} AUSD.`, `Enter at least ${MIN_DEPOSIT} AUSD.`);
  else if (cap && n.deposit > cap) err.deposit = L(`Registry membatasi ${cap} AUSD per vault.`, `The registry caps each vault at ${cap} AUSD.`);
  if (!(n.ratio > 0)) err.ratio = L("Rasio harus di atas 0%.", "Enter a ratio above 0%.");
  else if (n.ratio > 100) err.ratio = L("Rasio maksimal 100% dari ukuran leader.", "The ratio can't exceed 100% of the leader's size.");
  if (!(n.maxNotional > 0)) err.maxNotional = L("Masukkan jumlah positif.", "Enter a positive amount.");
  if (!(n.maxLev >= 1)) err.maxLev = L("Minimal 1x.", "Use at least 1x.");
  else if (n.maxLev > l.maxLeverage) err.maxLev = L(`Mandat leader maksimal ${l.maxLeverage}x.`, `The leader's mandate allows at most ${l.maxLeverage}x.`);
  if (!(n.chase >= 0)) err.chase = L("Masukkan 0 bps atau lebih.", "Enter 0 bps or more.");
  if (!(n.band > 0)) err.band = L("Pita harus di atas 0 bps.", "Enter a band above 0 bps.");
  if (!(n.stop >= 0 && n.stop <= 90)) err.stop = L("Gunakan 0 sampai 90%.", "Use 0 to 90%.");
  const invalid = Object.keys(err).length > 0 || !mkts.length;
  const ok = (k: keyof Form) => (err[k] ? null : n[k]);

  // Debounced settings for the backtest so typing does not fire a replay per keystroke; invalid input keeps the last valid run.
  const settings: FollowerSettings = { depositCNS: n.deposit, ratioBps: Math.round(n.ratio * 100), maxNotionalCNS: n.maxNotional, maxLeverageHdths: Math.round(n.maxLev * 100), maxChaseBps: Math.round(n.chase), priceBandBps: Math.round(n.band), stopLossBps: Math.round(n.stop * 100) };
  const [bt, setBt] = useState(settings);
  const key = invalid ? null : JSON.stringify(settings);
  useEffect(() => {
    if (!key) return;
    const id = setTimeout(() => setBt(JSON.parse(key)), 700);
    return () => clearTimeout(id);
  }, [key]);

  const dep = ok("deposit") ?? 0;
  const prot = l.followerAum + dep > 0 ? Math.min(100, ((l.bond + l.underwritten) / (l.followerAum + dep)) * 100) : 100;
  const example = 10_000;
  const copied = ok("ratio") != null && ok("maxNotional") != null ? Math.min(example * (n.ratio / 100), n.maxNotional) : null;

  // only built from valid input; submit is disabled otherwise
  const params = invalid
    ? null
    : {
        ratioBps: Math.round(n.ratio * 100),
        maxLeverageHdths: Math.round(n.maxLev * 100),
        maxChaseBps: Math.round(n.chase),
        priceBandBps: Math.round(n.band),
        stopLossBps: Math.round(n.stop * 100),
        maxNotionalCNS: toUnits(n.maxNotional),
        marketsMask: marketsMask(mkts),
      };

  async function submit() {
    if (!params) return;
    if (!isDeployed || !deployment?.registry || !deployment.ausd) return write("risky", {} as never);
    const reg = { address: deployment.registry, abi: copasAbi.CopasRegistry as Abi };
    // risky: one fresh passkey prompt; the follow-up calls sign inside the renewed session
    if (!(await write("risky", { ...reg, functionName: "createVault" }))) return;
    const vaults = (await copasPublic.readContract({ ...reg, functionName: "vaultsOf", args: [address] })) as `0x${string}`[];
    const vault = vaults[vaults.length - 1];
    const v = { address: vault, abi: copasAbi.FollowerVault as Abi };
    const amt = toUnits(n.deposit);
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
            <Field id="f-deposit" label={L("Setoran (AUSD)", "Deposit (AUSD)")} hint={cap ? L(`Registry membatasi ${cap} AUSD per vault.`, `The registry caps each vault at ${cap} AUSD.`) : undefined} error={err.deposit} min={MIN_DEPOSIT} max={cap ?? undefined} step={1} value={f.deposit} onChange={on("deposit")} />
            <Field
              id="f-ratio"
              label={L("Rasio copy (% dari ukuran leader)", "Copy ratio (% of leader size)")}
              hint={copied != null ? L(`Leader buka $${example.toLocaleString()} → kamu buka ${usd(copied, { dp: 0 })}.`, `Leader opens $${example.toLocaleString()} → you open ${usd(copied, { dp: 0 })}.`) : undefined}
              error={err.ratio}
              min={0.1}
              max={100}
              step={0.1}
              value={f.ratio}
              onChange={on("ratio")}
            />
            <Field id="f-notional" label={L("Notional maks per posisi (AUSD)", "Max notional per position (AUSD)")} error={err.maxNotional} min={1} step={10} value={f.maxNotional} onChange={on("maxNotional")} />
            <Field id="f-lev" label={L("Leverage maks", "Max leverage")} hint={L(`Mandat leader: ${l.maxLeverage}x.`, `Leader mandate: ${l.maxLeverage}x.`)} error={err.maxLev} min={1} max={l.maxLeverage} step={0.5} value={f.maxLev} onChange={on("maxLev")} />
            <Field id="f-chase" label={L("Batas kejar harga (bps)", "Max chase (bps)")} hint={L("Lewati penambahan posisi bila harga sudah bergerak sejauh ini dari harga masuk leader.", "Skip adding when price has moved this far from the leader's entry.")} error={err.chase} min={0} step={5} value={f.chase} onChange={on("chase")} />
            <Field id="f-stop" label={L("Stop-loss vault (%)", "Vault stop-loss (%)")} hint={L("Berhenti menyalin dan tutup posisi bila vault turun sejauh ini dalam satu epoch.", "Stop copying and close out if the vault falls this far within an epoch.")} error={err.stop} min={0} max={90} step={1} value={f.stop} onChange={on("stop")} />
            <Field id="f-band" label={L("Pita harga IOC (bps)", "IOC price band (bps)")} error={err.band} min={5} step={5} value={f.band} onChange={on("band")} />
            <fieldset>
              <legend className="text-sm text-ink-2">{L("Market yang disalin", "Markets to copy")}</legend>
              {!mkts.length && <p className="mt-1 text-xs text-down">{L("Pilih minimal satu market.", "Pick at least one market.")}</p>}
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

        <Panel title={L("Sebelum kamu ikut: argumen tandingan", "Before you follow: the case against")} aside={<span>AI · OpenRouter</span>}>
          <AnalysisPanel perplAddress={l.perplAccount} />
        </Panel>
      </div>

      <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
        <Panel title={L("Ringkasan", "Summary")}>
          <dl className="space-y-2 text-sm">
            {[
              [L("Setoran", "Deposit"), usd(ok("deposit"), { dp: 0 })],
              [L("Rasio", "Ratio"), pct(ok("ratio"), 1)],
              [L("Leverage maks", "Max leverage"), ok("maxLev") == null ? "–" : `${num(n.maxLev, 1)}x`],
              [L("Stop-loss vault", "Vault stop-loss"), pct(ok("stop"), 0)],
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
              {t("risk.body1")} {L(`Saat ini: ${usd(l.bond + l.underwritten, { dp: 0 })} untuk AUM ${usd(l.followerAum + dep, { dp: 0 })}.`, `Right now: ${usd(l.bond + l.underwritten, { dp: 0 })} against ${usd(l.followerAum + dep, { dp: 0 })} AUM.`)}
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
            {pending ? L("Menunggu passkey…", "Waiting for passkey…") : invalid ? L("Perbaiki setelan di atas", "Fix the settings above") : L(`Ikuti ${l.name} dengan ${n.deposit} AUSD`, `Follow ${l.name} with ${n.deposit} AUSD`)}
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
