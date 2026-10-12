"use client";
import { useState, useTransition } from "react";
import { useL } from "@/lib/i18n/client";
import { breachMath } from "@/lib/copas/math";
import { num, pct, usd } from "@/lib/format";
import { Source, btn } from "@/components/ui";
import { copasChain } from "@/lib/chains";
import { liveEquity } from "./actions";

const CHAIN = copasChain.name;

type Inputs = { equity: number; units: number; peak: number; maxDD: number; slash: number; capTotal: number; cap: number; loss: number };
const input = "num mt-1 w-full rounded-md border border-line-strong bg-bg px-2 py-1.5 text-sm focus:border-gold focus:outline-none";

/** Recompute breach and claim from the same inputs the contract used. Prefilled from the breach above; equity can be read live from Perpl. */
export function Recompute({ initial }: { initial: Inputs }) {
  const L = useL();
  const [v, setV] = useState(initial);
  const [q, setQ] = useState("");
  const [live, setLive] = useState<string>();
  const [busy, start] = useTransition();
  const r = breachMath(v);
  const set = (k: keyof Inputs) => (e: React.ChangeEvent<HTMLInputElement>) => setV({ ...v, [k]: Number(e.target.value) || 0 });

  const fields: [keyof Inputs, string][] = [
    ["equity", L("Equity (AUSD)", "Equity (AUSD)")],
    ["units", L("Total unit", "Total units")],
    ["peak", L("Puncak unit (HWM)", "Peak unit (HWM)")],
    ["maxDD", L("Max DD dideklarasikan (%)", "Declared max DD (%)")],
    ["slash", L("Jaminan dipotong", "Slashed bond")],
    ["capTotal", L("Σ cap follower", "Σ follower cap")],
    ["cap", L("Cap kamu", "Your cap")],
    ["loss", L("Rugi kamu", "Your loss")],
  ];

  function readLive() {
    start(async () => {
      const res = await liveEquity(q);
      if ("error" in res) {
        setV({ ...v, equity: initial.equity, units: initial.units, peak: initial.peak }); // drop a previous live read
        setLive(
          res.error === "bad-input"
            ? L("Masukkan alamat 0x… atau ID akun Perpl.", "Enter a 0x… address or Perpl account ID.")
            : res.error === "not-found"
              ? L("Bukan LeaderBook Copas dan tidak ada akun Perpl untuk input ini.", "Not a Copas LeaderBook, and no Perpl account for this input.")
              : L("RPC Monad tidak merespons. Coba lagi.", "Monad RPC did not respond. Try again."),
        );
        return;
      }
      const invalid = res.valid ? "" : L(" Harga mark belum valid.", " Mark price not valid yet.");
      if (res.kind === "book") {
        setV({ ...v, equity: Math.round(res.equity * 100) / 100, units: Math.round(res.units * 100) / 100, peak: Math.round(res.peak * 1e6) / 1e6 });
        setLive(L(`LeaderBook ${CHAIN}: unit price ${num(res.unit, 6)}, puncak ${num(res.peak, 6)}.`, `LeaderBook on ${CHAIN}: unit price ${num(res.unit, 6)}, peak ${num(res.peak, 6)}.`) + invalid);
        return;
      }
      setV({ ...v, equity: Math.round(res.equity * 100) / 100 });
      setLive(L(`Akun Perpl mainnet #${res.accountId}: saldo ${usd(res.balance)} + ${res.positions} posisi.`, `Perpl mainnet account #${res.accountId}: balance ${usd(res.balance)} + ${res.positions} positions.`) + invalid);
    });
  }

  return (
    <div className="rounded-md border border-line bg-bg p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium">{L("Hitung ulang", "Recompute")}</h3>
        <Source kind="rpc">{L("equity bisa dibaca live", "equity readable live")}</Source>
      </div>
      <div className="grid grid-cols-1 gap-3 min-[400px]:grid-cols-2">
        {fields.map(([k, label]) => (
          <label key={k} className="block text-xs text-ink-3">
            {label}
            <input type="number" step="any" inputMode="decimal" className={input} value={v[k]} onChange={set(k)} />
          </label>
        ))}
      </div>
      <form
        className="mt-3 flex flex-wrap gap-2 sm:flex-nowrap"
        onSubmit={(e) => {
          e.preventDefault();
          readLive();
        }}
      >
        <input
          aria-label={L("LeaderBook, alamat, atau ID akun Perpl", "LeaderBook, Perpl address or account ID")}
          placeholder={L("LeaderBook 0x…, alamat, atau ID akun Perpl", "LeaderBook 0x…, address or Perpl account ID")}
          className={input + " mt-0"}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button className={btn.ghost + " shrink-0 py-1.5"} disabled={busy || !q.trim()}>
          {busy ? L("Membaca…", "Reading…") : L("Baca equity", "Read equity")}
        </button>
      </form>
      {live && <p className="mt-2 text-xs text-ink-3" role="status">{live}</p>}
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-3 text-sm">
        <dt className="text-ink-3">u = equity / units</dt>
        <dd className="num text-right">{num(r.unit, 4)}</dd>
        <dt className="text-ink-3">dd = 1 − u / peak</dt>
        <dd className="num text-right">{pct(r.dd, 2)}</dd>
        <dt className="text-ink-3">dd &gt; maxDD</dt>
        <dd className={`num text-right ${r.breach ? "text-down" : "text-up"}`}>{r.breach ? L("breach", "breach") : L("aman", "within mandate")}</dd>
        <dt className="text-ink-3">claim</dt>
        <dd className="num text-right text-ink">{usd(r.claim)}</dd>
      </dl>
      <button className="mt-3 text-xs text-ink-3 underline hover:text-ink-2" onClick={() => (setV(initial), setLive(undefined))}>
        {L("Kembalikan ke data breach", "Reset to breach data")}
      </button>
    </div>
  );
}
