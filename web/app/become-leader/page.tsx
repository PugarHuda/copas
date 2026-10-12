"use client";
import { useState } from "react";
import { type Abi } from "viem";
import { Panel, PageHead, Source, btn } from "@/components/ui";
import { Seal } from "@/components/Seal";
import { useL, useT } from "@/lib/i18n/client";
import { useMeraSession } from "@/lib/mera/MeraProvider";
import { copasPublic, useCopasWrite } from "@/lib/copas/useCopasWrite";
import { TIERS, copasAbi, deployment, isDeployed, marketsMask, type Tier } from "@/lib/copas/contracts";
import { copasChain } from "@/lib/chains";
import { toAusd, usd } from "@/lib/format";
import { ImportTrackRecord } from "./ImportTrackRecord";

const input = "num mt-1 w-full rounded-md border border-line-strong bg-bg px-3 py-2 text-sm focus:border-gold focus:outline-none";

export default function BecomeLeader() {
  const L = useL();
  const { t } = useT();
  const { status, address } = useMeraSession();
  const { write, pending, error, hash } = useCopasWrite();
  const [tier, setTier] = useState<Tier>("moderat");
  const [dd, setDd] = useState(TIERS.moderat.maxDDbps / 100);
  const [lev, setLev] = useState(TIERS.moderat.maxLeverageHdths / 100);
  const [markets, setMarkets] = useState<string[]>([...TIERS.moderat.markets]);
  const [fee, setFee] = useState(15);
  const [epochH, setEpochH] = useState(168);
  const [capital, setCapital] = useState(copasChain.id === 143 ? 50 : 100);
  const [bond, setBond] = useState(25);
  const [book, setBook] = useState<`0x${string}`>();
  const [operator, setOperator] = useState("");

  const minBond = 25; // minBondAbs on mainnet demo; grows with follower AUM × 10%
  const pick = (k: Tier) => {
    setTier(k);
    setDd(TIERS[k].maxDDbps / 100);
    setLev(TIERS[k].maxLeverageHdths / 100);
    setMarkets([...TIERS[k].markets]);
  };
  // Same bounds LeaderBook._checkMandate enforces (DD (0, 90%], leverage 1-50x, fee ≤ 30%, epoch ≥ registry.minEpochLen = 1 h).
  const minCapital = copasChain.id === 143 ? 10 : 100;
  const err = {
    dd: dd >= 0.01 && dd <= 90 ? undefined : L("Gunakan 0.01 sampai 90%.", "Use 0.01 to 90%."),
    lev: lev >= 1 && lev <= 50 ? undefined : L("Gunakan 1x sampai 50x.", "Use 1x to 50x."),
    fee: fee >= 0 && fee <= 30 ? undefined : L("Gunakan 0 sampai 30%.", "Use 0 to 30%."),
    epochH: epochH >= 1 && epochH <= 8760 ? undefined : L("Gunakan 1 sampai 8760 jam.", "Use 1 to 8760 hours."),
    capital: capital >= minCapital && capital < 1e12 ? undefined : L(`Minimal ${minCapital} AUSD.`, `Enter at least ${minCapital} AUSD.`),
    bond: bond >= minBond && bond < 1e12 ? undefined : L(`Minimal ${minBond} AUSD.`, `Enter at least ${minBond} AUSD.`),
  };
  const badMandate = !!(err.dd || err.lev || err.fee || err.epochH || err.capital) || !markets.length;
  const mandate = { maxDDbps: Math.round(dd * 100), maxLeverageHdths: Math.round(lev * 100), feeBps: Math.round(fee * 100), epochLen: BigInt(Math.round((err.epochH ? 1 : epochH) * 3600)), maxNotionalCNS: toAusd(capital * lev), marketsMask: marketsMask(markets) };
  const reg = deployment?.registry ? { address: deployment.registry, abi: copasAbi.CopasRegistry as Abi } : undefined;
  const lb = book ? { address: book, abi: copasAbi.LeaderBook as Abi } : undefined;
  const tiers: { k: Tier; name: string; body: string }[] = [
    { k: "konservatif", name: L("Konservatif", "Conservative"), body: L("DD 5%, lev. 3x, BTC/ETH", "5% DD, 3x lev., BTC/ETH") },
    { k: "moderat", name: L("Moderat", "Moderate"), body: L("DD 15%, lev. 5x, + SOL", "15% DD, 5x lev., + SOL") },
    { k: "agresif", name: L("Agresif", "Aggressive"), body: L("DD 30%, lev. 10x, + MON", "30% DD, 10x lev., + MON") },
  ];

  const open = async () => {
    if (!reg) return write("risky", {} as never);
    if (await write("risky", { ...reg, functionName: "createLeader", args: [mandate] })) {
      const books = (await copasPublic.readContract({ ...reg, functionName: "leadersOf", args: [address] }).catch(() => [])) as `0x${string}`[];
      setBook(books[books.length - 1]);
    }
  };

  return (
    <div className="space-y-6">
      <PageHead title={t("nav.becomeLeader")} lede={L("Leader Copas menaruh jaminan dan janji tertulis. Follower membayar fee hanya di atas high-water mark, dan dibayar dari jaminanmu bila kamu ingkar.", "Copas leaders post a bond and a written promise. Followers pay fees only above their high-water mark, and are paid from your bond if you break it.")}>
        {!isDeployed && <Source kind="mock">{L("Kontrak belum di-deploy: formulir bisa diisi, transaksi aktif setelah deploy.", "Contracts not deployed: the form works, transactions go live after deployment.")}</Source>}
      </PageHead>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <ImportTrackRecord onApply={pick} />
          <Panel title={L("1. Pilih mandat", "1. Choose a mandate")}>
            <div className="grid gap-3 sm:grid-cols-3" role="group" aria-label="Tier">
              {tiers.map((x) => (
                <button key={x.k} aria-pressed={tier === x.k} onClick={() => pick(x.k)} className={`rounded-lg border p-3 text-left ${tier === x.k ? "border-gold bg-surface-2" : "border-line hover:border-line-strong"}`}>
                  <div className="font-medium">{x.name}</div>
                  <div className="mt-1 text-xs text-ink-3">{x.body}</div>
                </button>
              ))}
            </div>
            <div className="mt-5 grid gap-4 sm:grid-cols-3">
              <label className="text-sm text-ink-2">
                {L("Drawdown maks per epoch (%)", "Max drawdown per epoch (%)")}
                <input type="number" min={0.01} max={90} step={0.5} value={dd} onChange={(e) => (setDd(Number(e.target.value)), setTier("moderat"))} aria-invalid={!!err.dd} className={input + " aria-[invalid=true]:border-down"} />
                {err.dd && <span role="alert" className="mt-1 block text-xs text-down">{err.dd}</span>}
              </label>
              <label className="text-sm text-ink-2">
                {L("Leverage maks", "Max leverage")}
                <input type="number" min={1} max={50} step={0.5} value={lev} onChange={(e) => setLev(Number(e.target.value))} aria-invalid={!!err.lev} className={input + " aria-[invalid=true]:border-down"} />
                {err.lev && <span role="alert" className="mt-1 block text-xs text-down">{err.lev}</span>}
              </label>
              <label className="text-sm text-ink-2">
                {L("Fee kinerja (%)", "Performance fee (%)")}
                <input type="number" min={0} max={30} value={fee} onChange={(e) => setFee(Number(e.target.value))} aria-invalid={!!err.fee} className={input + " aria-[invalid=true]:border-down"} />
                {err.fee && <span role="alert" className="mt-1 block text-xs text-down">{err.fee}</span>}
              </label>
              <label className="text-sm text-ink-2">
                {L("Panjang epoch (jam)", "Epoch length (hours)")}
                <input type="number" min={1} value={epochH} onChange={(e) => setEpochH(Number(e.target.value))} aria-invalid={!!err.epochH} className={input + " aria-[invalid=true]:border-down"} />
                {err.epochH && <span role="alert" className="mt-1 block text-xs text-down">{err.epochH}</span>}
              </label>
              <fieldset className="sm:col-span-2">
                <legend className="text-sm text-ink-2">{L("Market", "Markets")}</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {["BTC", "ETH", "SOL", "MON"].map((m) => (
                    <label key={m} className={`cursor-pointer rounded border px-2.5 py-1 text-sm ${markets.includes(m) ? "border-gold" : "border-line-strong text-ink-3"}`}>
                      <input type="checkbox" className="sr-only" checked={markets.includes(m)} onChange={(e) => setMarkets(e.target.checked ? [...markets, m] : markets.filter((x) => x !== m))} />
                      {m}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            <p className="mt-4 text-xs text-ink-3">{L("Perubahan mandat berlaku mulai epoch berikutnya. Order di luar mandat ditolak kontrak; leverage efektif yang naik melewati batas memicu breach saat checkpoint.", "Mandate changes take effect next epoch. Orders outside the mandate revert; effective leverage drifting past the cap triggers a breach at checkpoint.")}</p>
          </Panel>

          <Panel title={L("2. Buka LeaderBook", "2. Open your LeaderBook")}>
            <p className="text-sm text-ink-2">{L("Kontrak ini memegang akun Perpl kamu, menghitung harga unit, dan menegakkan mandat.", "This contract holds your Perpl account, prices your units and enforces the mandate.")}</p>
            <button className={btn.primary + " mt-3"} disabled={status !== "signed-in" || pending || badMandate} onClick={open}>
              {L("Buka LeaderBook", "Open LeaderBook")}
            </button>
          </Panel>

          <Panel title={L("3. Setor modal trading", "3. Deposit trading capital")}>
            <label className="text-sm text-ink-2">
              AUSD
              <input type="number" min={copasChain.id === 143 ? 10 : 100} value={capital} onChange={(e) => setCapital(Number(e.target.value))} aria-invalid={!!err.capital} className={input + " aria-[invalid=true]:border-down"} />
                {err.capital && <span role="alert" className="mt-1 block text-xs text-down">{err.capital}</span>}
            </label>
            <p className="mt-2 text-xs text-ink-3">{L(`Minimum buka akun Perpl: ${copasChain.id === 143 ? 10 : 100} AUSD. Setoran mencetak unit pada harga unit saat ini.`, `Perpl account minimum: ${copasChain.id === 143 ? 10 : 100} AUSD. Deposits mint units at the current unit price.`)}</p>
            <button className={btn.ghost + " mt-3"} disabled={!lb || pending || !!err.capital} onClick={() => lb && write("small", { ...lb, functionName: "deposit", args: [toAusd(capital)] })}>
              {L("Setor", "Deposit")}
            </button>
          </Panel>

          <Panel title={L("4. Taruh jaminan", "4. Post your bond")}>
            <label className="text-sm text-ink-2">
              AUSD
              <input type="number" min={minBond} value={bond} onChange={(e) => setBond(Number(e.target.value))} aria-invalid={!!err.bond} className={input + " aria-[invalid=true]:border-down"} />
                {err.bond && <span role="alert" className="mt-1 block text-xs text-down">{err.bond}</span>}
            </label>
            <p className="mt-2 text-xs text-ink-3">{L("Jaminan minimum = maks(25 AUSD, 10% × AUM follower). Di bawah itu status jadi Unbonded dan follower baru ditolak. Penarikan jaminan butuh satu epoch penuh dan tetap bisa dipotong selama menunggu.", "Minimum bond = max(25 AUSD, 10% × follower AUM). Below it you become Unbonded and new followers are refused. Unbonding takes a full epoch and stays slashable while pending.")}</p>
            <button className={btn.primary + " mt-3"} disabled={!lb || pending || !!err.bond} onClick={() => lb && write("risky", { ...lb, functionName: "postBond", args: [toAusd(bond)] })}>
              {L("Taruh jaminan", "Post bond")}
            </button>
          </Panel>

          <Panel title={L("Opsional: leader AI agent", "Optional: AI agent leader")}>
            <p className="text-sm text-ink-2">{L("Tetapkan alamat agent sebagai operator. Agent bisa trading lewat trade(), tetap dibatasi mandat; jaminan tetap milikmu dan yang dipotong.", "Set an agent address as operator. It trades through trade(), bound by the mandate; the bond stays yours and is what gets slashed.")}</p>
            <label htmlFor="operator" className="mt-3 block text-sm text-ink-2">
              {L("Alamat operator", "Operator address")}
            </label>
            <input id="operator" placeholder="0x…" value={operator} onChange={(e) => setOperator(e.target.value)} className={input} />
            <button className={btn.ghost + " mt-3"} disabled={!lb || pending || !/^0x[0-9a-fA-F]{40}$/.test(operator)} onClick={() => lb && write("risky", { ...lb, functionName: "setOperator", args: [operator] })}>
              {L("Tetapkan operator", "Set operator")}
            </button>
          </Panel>
          {error === "contracts-not-deployed" && <p role="alert" className="text-sm text-warn">{L("Kontrak belum di-deploy di jaringan ini.", "Contracts are not deployed on this network yet.")}</p>}
          {error && error !== "contracts-not-deployed" && <p role="alert" className="text-sm text-down">{error}</p>}
          {hash && <p className="num text-xs text-ink-3">tx {hash}</p>}
        </div>
        <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <Panel title={L("Segelmu", "Your seal")}>
            <div className="flex justify-center py-2">
              <Seal bond={err.bond ? 0 : bond} maxDD={err.dd ? 0 : dd} size="lg" />
            </div>
            <dl className="mt-3 space-y-1.5 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-3">{L("Leverage maks", "Max leverage")}</dt>
                <dd className="num">{err.lev ? "–" : `${lev}x`}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-3">Market</dt>
                <dd>{markets.join(", ") || "–"}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-3">{L("Kapasitas AUM awal", "Starting AUM capacity")}</dt>
                <dd className="num">{err.capital || err.bond ? "–" : usd(Math.min(3 * capital, 20 * bond), { dp: 0 })}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-ink-3">{L("Kapasitas = min(3 × equity, 20 × jaminan).", "Capacity = min(3 × equity, 20 × bond).")}</p>
          </Panel>
          {status !== "signed-in" && <p className="text-sm text-ink-3">{L("Masuk dengan passkey untuk mengirim transaksi.", "Sign in with your passkey to send transactions.")}</p>}
        </aside>
      </div>
    </div>
  );
}
