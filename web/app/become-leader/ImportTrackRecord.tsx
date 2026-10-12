"use client";
import { useState } from "react";
import { Panel, Source, btn } from "@/components/ui";
import { pct, usd } from "@/lib/format";
import type { Tier } from "@/lib/copas/contracts";

type Res = {
  user: string; accountValue: number; leverage: number; openPositions: number;
  allTime: { pnl: number; volume: number; maxDD: number; since: number | null };
  month: { pnl: number; volume: number; maxDD: number; ret: number };
  suggestion: { tier: Tier; maxDD: number } | null;
};
const TIER_NAME: Record<Tier, string> = { konservatif: "Conservative", moderat: "Moderate", agresif: "Aggressive" };
const input = "num w-full rounded-md border border-line-strong bg-bg px-3 py-2 text-sm focus:border-gold focus:outline-none";

/** Informational: reads a Hyperliquid address's public perps history via /api/hyperliquid and suggests a Copas mandate tier. */
export function ImportTrackRecord({ onApply }: { onApply: (t: Tier) => void }) {
  const [addr, setAddr] = useState("");
  const [res, setRes] = useState<Res | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = /^0x[0-9a-fA-F]{40}$/.test(addr.trim());

  const load = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return setErr("Enter a 0x address (40 hex characters).");
    setBusy(true); setErr(""); setRes(null);
    try {
      const r = await fetch(`/api/hyperliquid?user=${addr.trim()}`, { signal: AbortSignal.timeout(20_000) });
      const j = await r.json();
      if (!r.ok) setErr(j.error ?? `Request failed (${r.status}).`);
      else setRes(j);
    } catch {
      setErr("Could not reach the import service. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const row = (k: string, v: React.ReactNode, tone = "") => (
    <div className="flex justify-between gap-3 py-1">
      <dt className="text-ink-3">{k}</dt>
      <dd className={`num ${tone}`}>{v}</dd>
    </div>
  );
  const t = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "");

  return (
    <Panel title="Import your track record" aside={<Source kind="live">api.hyperliquid.xyz/info · informational, not onchain-verified</Source>}>
      <p className="text-sm text-ink-2">Trade on Hyperliquid already? Paste your address to see your perps history and the Copas mandate it fits. Nothing here is signed or stored, and followers never see it as proof: on Copas only the LeaderBook record counts.</p>
      <form onSubmit={load} className="mt-3 flex flex-col gap-2 sm:flex-row">
        <label htmlFor="hl-addr" className="sr-only">Hyperliquid address</label>
        <input id="hl-addr" placeholder="0x… Hyperliquid address" value={addr} onChange={(e) => (setAddr(e.target.value), setRes(null), setErr(""))} className={input} aria-invalid={!!addr && !valid} />
        <button type="submit" className={btn.ghost + " shrink-0"} disabled={busy || !addr}>
          {busy ? "Reading…" : "Import"}
        </button>
      </form>
      {err && <p role="alert" className="mt-2 text-sm text-down">{err}</p>}
      {res && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <dl className="text-sm">
            {row("Account value", usd(res.accountValue, { dp: 0 }))}
            {row("All-time perps PnL", usd(res.allTime.pnl, { sign: true, dp: 0 }), t(res.allTime.pnl))}
            {row("30-day perps PnL", usd(res.month.pnl, { sign: true, dp: 0 }), t(res.month.pnl))}
            {row("30-day return", pct(res.month.ret, 1, true), t(res.month.ret))}
            {row("Max drawdown, 30 days", pct(res.month.maxDD, 1))}
            {row("Max drawdown, all time", pct(res.allTime.maxDD, 1))}
            {row("Current leverage", `${res.leverage.toFixed(2)}x · ${res.openPositions} open`)}
            {row("All-time volume", usd(res.allTime.volume, { compact: true, dp: 0 }))}
          </dl>
          <div className="rounded-md border border-line bg-bg p-3 text-sm">
            <p className="micro text-ink-3">Suggested mandate</p>
            {res.suggestion ? (
              <>
                <p className="display mt-1 text-3xl">{TIER_NAME[res.suggestion.tier]}</p>
                <p className="mt-1 text-ink-2">
                  {res.suggestion.maxDD}% max drawdown per epoch: your 30-day drawdown of {pct(res.month.maxDD, 1)} plus 25% headroom fits under it.
                </p>
                <button type="button" className={btn.primary + " mt-3"} onClick={() => onApply(res.suggestion!.tier)}>
                  Use this tier
                </button>
              </>
            ) : (
              <p className="mt-1 text-ink-2">Your 30-day drawdown of {pct(res.month.maxDD, 1)} would break even the 30% Aggressive mandate. Trade smaller before bonding, or that bond gets slashed.</p>
            )}
            <p className="mt-3 text-xs text-ink-3">Drawdown is measured on a return index (each step&apos;s PnL over the prior account value), so deposits and withdrawals don&apos;t count as gains or losses.</p>
          </div>
        </div>
      )}
    </Panel>
  );
}
