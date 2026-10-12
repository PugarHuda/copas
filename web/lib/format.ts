/** Display helpers. All amounts are plain numbers in AUSD (≈ USD) unless stated. */

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

export function usd(v: number | null | undefined, opts: { compact?: boolean; sign?: boolean; dp?: number } = {}) {
  if (v == null || !Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  const body =
    opts.compact && a >= 10_000
      ? compact.format(a)
      : a.toLocaleString("en-US", { minimumFractionDigits: opts.dp ?? 2, maximumFractionDigits: opts.dp ?? 2 });
  const sign = /[1-9]/.test(body) ? (opts.sign && v > 0 ? "+" : v < 0 ? "−" : "") : ""; // never "−$0" or "+$0.00"
  return `${sign}$${body}`;
}

export function num(v: number | null | undefined, dp = 2, compactIt = false) {
  if (v == null || !Number.isFinite(v)) return "–";
  if (compactIt && Math.abs(v) >= 10_000) return compact.format(v);
  return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function pct(v: number | null | undefined, dp = 2, sign = false) {
  if (v == null || !Number.isFinite(v)) return "–";
  const body = Math.abs(v).toFixed(dp);
  const s = Number(body) === 0 ? "" : sign && v > 0 ? "+" : v < 0 ? "−" : ""; // never "−0.0%"
  return `${s}${body}%`;
}

/** Percent with as many decimals as the magnitude needs, so a small non-zero value never reads as 0% (0.01 → 0.01%, 15 → 15%). */
export function pctAuto(v: number | null | undefined, sign = false) {
  if (v == null || !Number.isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a > 0 && a < 0.001) return `<0.001%`;
  const body = a >= 10 ? Math.round(a) : Number(a.toPrecision(2));
  const s = body === 0 ? "" : sign && v > 0 ? "+" : v < 0 ? "−" : "";
  return `${s}${body}%`;
}

/** Price with sensible precision for the magnitude (PUMP ~0.006, BTC ~85k). */
export function price(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v) || v === 0) return "–";
  const dp = v >= 1000 ? 1 : v >= 10 ? 2 : v >= 1 ? 3 : v >= 0.01 ? 4 : 6;
  return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

export function ago(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export const tone = (v: number | null | undefined) => (v == null || v === 0 ? "text-ink-2" : v > 0 ? "text-up" : "text-down");

export const isAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());
