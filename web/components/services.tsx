"use client";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { verifyMessage, type Hex } from "viem";
import { useL } from "@/lib/i18n/client";
import { num, pct, usd } from "@/lib/format";
import { TimeChart } from "./TimeChart";
import { Pill, Source, Stat } from "./ui";

/**
 * UI for @copas/services (copas/services) through /api/services/*.
 * A missing key answers 503 {error, missing}; every panel degrades to its deterministic numbers.
 */
type Res<T> = { ok: boolean; status: number; data: T & { error?: string; missing?: string | string[] } };
async function call<T>(path: string, body?: unknown): Promise<Res<T>> {
  const r = await fetch(`/api/services/${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const data = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  return { ok: r.ok, status: r.status, data };
}

/** Server errors are developer strings ("bad params", "leader has no fills in the window"); show readers what they mean. */
export function friendlyError(e?: string) {
  if (!e) return "The service did not answer. Try again shortly.";
  if (/no fills/i.test(e)) return "This trader has no Perpl fills in the last 30 days, so there is nothing to replay.";
  if (/closed trades/i.test(e)) return "Not enough closed trades to backtest yet";
  if (/bad params|invalid|must be/i.test(e)) return "These settings can't be simulated. Check the values and try again.";
  if (/unreachable|timeout|HTTP 5\d\d|fetch failed|ECONN/i.test(e)) return "The analysis service is unreachable right now. Try again shortly.";
  if (/rate|429/i.test(e)) return "Too many requests. Wait a moment and try again.";
  return "The service could not complete this request. Try again shortly.";
}

/**
 * LLM narration sometimes leaks feature internals: camelCase field names, unix timestamps, "severity 0.9".
 * Rewrite them for people; the numbers themselves are untouched.
 */
export function humanize(text: string) {
  return text
    .replace(/\s*\(?\bseverity[\s:=]*\d*\.?\d+\)?/gi, "")
    .replace(/\b1[5-9]\d{8}(\d{3})?\b/g, (ts) => new Date(Number(ts) * (ts.length === 13 ? 1 : 1000)).toISOString().slice(0, 10))
    .replace(/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g, (id) => id.replace(/([A-Z])/g, " $1").toLowerCase().replace(/\bpnl\b/g, "PnL").replace(/\bpct\b/g, "%"))
    .replace(/\s{2,}/g, " ")
    .trim();
}

const Missing = ({ what }: { what?: string | string[] }) => {
  const L = useL();
  return (
    <p className="text-xs text-ink-3">
      {L("Layanan belum dikonfigurasi", "Service not configured")}: <code className="num">{Array.isArray(what) ? what.join(", ") : what}</code>
    </p>
  );
};

/* ------------------------------------ C3 ------------------------------------ */

export type FollowerSettings = { depositCNS: number; ratioBps: number; maxNotionalCNS: number; maxLeverageHdths: number; maxChaseBps: number; priceBandBps: number; stopLossBps: number };
type Backtest = {
  equityCurve: { ts: number; equity: number; leaderUnitPrice: number }[];
  summary: { startEquity: number; endEquity: number; netPnl: number; returnPct: number; maxDrawdownPct: number; fees: number; slippageCost: number; perfFees: number; copiedFills: number; skippedChase: number; epochs: number; breachedEpochs: number; compensation: number; netPnlWithCompensation: number };
  assumptions: string[];
};

export function BacktestPanel({ perplAddress, follower, mandate }: { perplAddress?: string; follower?: FollowerSettings; mandate?: { maxDDbps: number; epochLen: number; maxLeverageHdths?: number } }) {
  const L = useL();
  const key = JSON.stringify({ perplAddress, follower, mandate });
  const q = useQuery({
    queryKey: ["backtest", key],
    queryFn: () => call<Backtest>(`leader/${perplAddress}/backtest`, { follower, mandate, days: 30 }),
    enabled: !!perplAddress,
    staleTime: 60_000,
  });
  const series = useMemo(() => {
    const d = q.data?.ok ? q.data.data : null;
    if (!d) return null;
    // thin to ≤ 400 points; keep the last point of each bucket
    const step = Math.max(1, Math.ceil(d.equityCurve.length / 400));
    const pts = d.equityCurve.filter((_, i) => i % step === step - 1 || i === d.equityCurve.length - 1);
    return [{ name: L("Equity vault (simulasi)", "Vault equity (simulated)"), kind: "area" as const, color: "#3987e5", data: pts.map((p) => ({ t: p.ts * 1000, v: p.equity })) }];
  }, [q.data, L]);
  if (!perplAddress) return <p className="text-sm text-ink-3">{L("Leader ini belum punya histori Perpl untuk diputar ulang.", "This leader has no Perpl history to replay yet.")}</p>;
  if (q.isLoading) return <div className="h-60 animate-pulse rounded bg-surface-2/60" />;
  if (!q.data?.ok) return q.data?.status === 503 ? <Missing what={q.data.data.missing} /> : <p className="text-sm text-ink-3">{friendlyError(q.data?.data.error)}</p>;
  const s = q.data.data.summary;
  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label={L("Hasil 30 hari", "30-day result")} value={usd(s.netPnl, { sign: true })} sub={pct(s.returnPct, 1, true)} tone={s.netPnl >= 0 ? "text-up" : "text-down"} />
        <Stat label={L("Drawdown maks", "Max drawdown")} value={pct(s.maxDrawdownPct, 1)} />
        <Stat label={L("Epoch melanggar", "Epochs breached")} value={`${s.breachedEpochs} / ${s.epochs}`} sub={s.compensation ? `${L("kompensasi", "compensation")} ${usd(s.compensation)}` : undefined} />
        <Stat label={L("Biaya + slippage", "Fees + slippage")} value={usd(s.fees + s.slippageCost + s.perfFees)} sub={`${s.copiedFills} ${L("fill disalin", "fills copied")}${s.skippedChase ? `, ${s.skippedChase} ${L("dilewati", "skipped")}` : ""}`} />
      </div>
      {series && <TimeChart ariaLabel="Backtest" height={200} series={series} />}
      <details className="mt-2 text-xs text-ink-3">
        <summary className="cursor-pointer hover:text-ink-2">{L("Asumsi backtest", "Backtest assumptions")}</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {q.data.data.assumptions.map((a) => (
            <li key={a}>{humanize(a)}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/* --------------------------------- D1 / D3 ---------------------------------- */

type Bi = { en: string; id: string };
type Analysis = {
  analysis?: { riskLevel: "low" | "medium" | "high"; styleSummary: Bi; tilt: Bi & { detected: boolean }; drift: Bi & { detected: boolean }; weeklySummary: Bi; devilsAdvocate: (Bi & { key: string; metric: string; value: number })[] };
  features: { style: { trades: number; winRate: number; profitFactor: number | null; avgHoldHours: number; avgLeverage: number | null; label: string; topMarket: string | null; makerShare: number }; tilt: { detected: boolean }; drift: { detected: boolean }; reasonsNotToFollow: { key: string; severity: number; detail: string }[] };
  model?: string;
  unavailable?: string;
  signature?: unknown;
  signatureValid?: boolean | null;
  verifyUrl?: string;
  costUsd?: number;
  nonce?: string;
  outputHash?: string;
};

export function useAnalysis(addr?: string) {
  return useQuery({ queryKey: ["analysis", addr], queryFn: () => call<Analysis>(`leader/${addr?.toLowerCase()}/analysis`) /* one CDN cache entry per leader: each miss is an LLM call */, enabled: !!addr, staleTime: 300_000 });
}

export function AnalysisPanel({ perplAddress }: { perplAddress?: string }) {
  const L = useL();
  const q = useAnalysis(perplAddress);
  const lang = L("id", "en") as "id" | "en";
  if (!perplAddress) return <p className="text-sm text-ink-3">{L("Belum ada histori untuk dianalisis.", "No history to analyse yet.")}</p>;
  if (q.isLoading) return <div className="h-40 animate-pulse rounded bg-surface-2/60" />;
  const d = q.data?.data;
  if (!d?.features) return <p className="text-sm text-ink-3">{friendlyError(d?.error)}</p>;
  const f = d.features.style;
  const a = d.analysis;
  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap gap-2">
        {a && <Pill tone={a.riskLevel === "high" ? "down" : a.riskLevel === "medium" ? "warn" : "up"}>{L("Risiko", "Risk")}: {a.riskLevel}</Pill>}
        <Pill>{f.label[0].toUpperCase() + f.label.slice(1)}</Pill>
        <Pill tone={d.features.tilt.detected ? "warn" : "neutral"}>{d.features.tilt.detected ? L("Tilt terdeteksi", "Tilt detected") : L("Tanpa tilt", "No tilt")}</Pill>
        <Pill tone={d.features.drift.detected ? "warn" : "neutral"}>{d.features.drift.detected ? L("Style drift", "Style drift") : L("Gaya stabil", "Stable style")}</Pill>
      </div>
      {a ? (
        <>
          <p className="text-ink-2">{humanize(a.styleSummary[lang])}</p>
          {a.tilt.detected && <p className="text-warn">{humanize(a.tilt[lang])}</p>}
          {a.drift.detected && <p className="text-warn">{humanize(a.drift[lang])}</p>}
        </>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Trades 30d" value={f.trades} />
          <Stat label="Win rate" value={pct(f.winRate * 100, 0)} />
          <Stat label="Profit factor" value={f.profitFactor == null ? "–" : num(f.profitFactor, 2)} />
          <Stat label={L("Lama posisi", "Avg hold")} value={`${num(f.avgHoldHours, 1)}h`} />
        </div>
      )}
      <div>
        <h3 className="mb-2 text-xs text-ink-3">{L("Alasan untuk tidak mengikuti", "Reasons not to follow")}</h3>
        <ul className="space-y-1.5">
          {(a?.devilsAdvocate.map((x) => ({ key: x.key, text: x[lang] })) ?? d.features.reasonsNotToFollow.slice(0, 3).map((x) => ({ key: x.key, text: x.detail }))).map((x) => (
            <li key={x.key} className="flex gap-2 text-ink-2">
              <span aria-hidden className="text-warn">!</span>
              {humanize(x.text)}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-xs text-ink-3">
        {a ? (
          <>
            <span>{d.model ?? "AI"}{d.signature ? ` · ${d.signatureValid ? L("signature terverifikasi", "signature verified") : L("signature belum terverifikasi", "signature not verified")}` : ""}</span>
            {d.signature && d.verifyUrl && (
              <a href={d.verifyUrl} target="_blank" rel="noreferrer" className="hover:text-ink-2">
                {L("Cek signature", "Check signature")}
              </a>
            )}
            {d.costUsd != null && <span className="num">{L("biaya analisis", "analysis cost")} ${d.costUsd.toFixed(4)}</span>}
          </>
        ) : (
          <>
            {d.unavailable ? (
              <span>{L("Angka dihitung deterministik. Narasi AI sedang tidak tersedia (kuota penyedia model habis); coba lagi nanti.", "Numbers are deterministic. AI narration is unavailable right now (model provider quota reached); try again later.")}</span>
            ) : (
              <span>{L("Angka dihitung deterministik. Narasi AI butuh", "Numbers are deterministic. AI narration needs")} <code>OPENROUTER_API_KEY</code>.</span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------- D2 ------------------------------------ */

export function AlignmentBadge({ perplAddress }: { perplAddress?: string }) {
  const L = useL();
  const q = useQuery({
    queryKey: ["alignment", perplAddress],
    queryFn: () =>
      call<{ unavailable?: string; alignment: { score: number | null; coverage: number; poweredBy?: string | null }; composite: { score: number | null; poweredBy?: string | null } }>(`leader/${perplAddress}/alignment`),
    enabled: !!perplAddress,
    staleTime: 600_000,
  });
  if (!q.data?.ok) return null; // Nansen not configured: show nothing rather than a fake score
  const d = q.data.data;
  // credits out (or no data) answers 200 with null scores: a badge with nothing in it is noise, so show nothing
  if (d.composite.score == null && d.alignment.score == null) return null;
  const by = d.alignment.poweredBy ?? d.composite.poweredBy;
  return (
    <span className="inline-flex items-center gap-2 rounded border border-line-strong px-2 py-1 text-xs">
      {d.composite.score != null && (
        <span>
          {L("Skor", "Score")} <span className="num text-ink">{num(d.composite.score, 0)}</span>
        </span>
      )}
      {d.alignment.score != null && (
        <span>
          {L("searah smart money", "smart-money aligned")} <span className="num text-ink">{pct(d.alignment.score, 0)}</span>
        </span>
      )}
      {by && <span className="text-ink-3">Powered by {by}</span>}
    </span>
  );
}

/* ------------------------------------- A7 ------------------------------------ */

export function AttestedBadge({ perplAddress }: { perplAddress?: string }) {
  const L = useL();
  const [valid, setValid] = useState<boolean | null>(null);
  const q = useQuery({
    queryKey: ["attest", perplAddress],
    queryFn: () => call<{ record: { pnl30d: string; winRateBps: number; closedTrades: number; maxDrawdown: string; complete?: boolean }; complete?: boolean; hash: Hex; signature: Hex; attester: `0x${string}`; label: string }>(`attest/${perplAddress}`),
    enabled: !!perplAddress,
    staleTime: 600_000,
  });
  if (!q.data?.ok) return null;
  const a = q.data.data;
  const check = async () => setValid(await verifyMessage({ address: a.attester, message: { raw: a.hash }, signature: a.signature }).catch(() => false));
  return (
    <span className="inline-flex flex-wrap items-center gap-2 rounded border border-gold/40 px-2 py-1 text-xs">
      <span className="text-gold-2">{a.label}</span>
      <span className="num text-ink-2">
        PnL 30d {usd(Number(a.record.pnl30d), { sign: true, dp: Math.abs(Number(a.record.pnl30d)) < 10 ? 2 : 0 })} · WR {pct(a.record.winRateBps / 100, 0)} · {a.record.closedTrades} {a.record.closedTrades === 1 ? "trade" : "trades"}
      </span>
      {(a.record.complete ?? a.complete) === false && <span className="text-warn">{L("histori parsial", "partial history")}</span>}
      <button onClick={check} className="text-ink-3 underline-offset-2 hover:text-ink-2 hover:underline">
        {valid == null ? L("Verifikasi tanda tangan", "Verify signature") : valid ? L("Valid ✓", "Valid ✓") : L("Tidak valid", "Invalid")}
      </button>
    </span>
  );
}

/* ------------------------------------- C4 ------------------------------------ */

export function SimulatePreview({ tx }: { tx?: { from: `0x${string}`; to: `0x${string}`; data: Hex; chainId: number } }) {
  const L = useL();
  const q = useQuery({
    queryKey: ["simulate", tx],
    queryFn: () => call<{ engine: string; success: boolean; error?: string; balanceChanges: { symbol?: string; diff: string; decimals?: number; address: string }[]; events: { name?: string }[]; url?: string }>("simulate", tx),
    enabled: !!tx,
  });
  if (!tx) return <p className="text-xs text-ink-3">{L("Masuk untuk melihat simulasi transaksi.", "Sign in to preview the transaction.")}</p>;
  if (q.isLoading) return <p className="text-xs text-ink-3">{L("Mensimulasikan…", "Simulating…")}</p>;
  if (!q.data?.ok) return q.data?.status === 503 ? <Missing what={q.data.data.missing} /> : <p className="text-xs text-ink-3">{friendlyError(q.data?.data.error)}</p>;
  const d = q.data.data;
  return (
    <div className="text-xs">
      <Source kind="live">{d.engine}</Source>
      <p className={d.success ? "mt-1 text-up" : "mt-1 text-down"}>{d.success ? L("Simulasi berhasil", "Simulation succeeded") : d.error}</p>
      <ul className="mt-1 text-ink-2">
        {d.balanceChanges.map((b) => (
          <li key={b.address + b.symbol} className="num">
            {b.symbol ?? b.address.slice(0, 8)} {Number(b.diff) / 10 ** (b.decimals ?? 18)}
          </li>
        ))}
        {d.events.slice(0, 6).map((e, i) => (
          <li key={i}>{e.name ?? "event"}</li>
        ))}
      </ul>
    </div>
  );
}
