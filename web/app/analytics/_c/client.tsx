"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { isAddress, num, pct, price, short, usd } from "@/lib/format";
import { useL } from "@/lib/i18n/client";
import type { MarketRow } from "@/lib/perpl/analytics";
import type { MarketState } from "@/lib/perpl/api";
import { btn } from "@/components/ui";

/* ------------------------------- wallet search ------------------------------ */

export function WalletSearch({ compact = false }: { compact?: boolean }) {
  const router = useRouter();
  const L = useL();
  const [v, setV] = useState("");
  const [err, setErr] = useState(false);
  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const s = v.trim();
    if (isAddress(s) || /^\d{1,7}$/.test(s)) router.push(`/analytics/wallet/${s.toLowerCase()}`);
    else setErr(true);
  };
  return (
    <form onSubmit={go} role="search" className={`flex w-full flex-wrap gap-2 ${compact ? "max-w-md" : "max-w-xl"}`}>
      <label htmlFor="wsearch" className="sr-only">
        {L("Cari alamat wallet atau ID akun", "Search a wallet address or account ID")}
      </label>
      <input
        id="wsearch"
        value={v}
        onChange={(e) => (setV(e.target.value), setErr(false))}
        placeholder={L("Alamat 0x… atau ID akun Perpl", "0x… address or Perpl account ID")}
        aria-invalid={err}
        className="num min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-3 py-2 text-sm placeholder:text-ink-3 focus:border-gold focus:outline-none aria-[invalid=true]:border-down"
      />
      <button className={btn.primary}>{L("Buka", "Open")}</button>
      {err && (
        <span role="alert" className="basis-full text-xs text-down">
          {L("Masukkan alamat 0x 40 karakter atau ID akun.", "Enter a 40-character 0x address or an account ID.")}
        </span>
      )}
    </form>
  );
}

/* -------------------------------- live markets ------------------------------ */

type Meta = { id: number; pd: number; sd: number };

export function LiveMarkets({ rows, meta }: { rows: MarketRow[]; meta: Meta[] }) {
  const L = useL();
  const { data, dataUpdatedAt } = useQuery({
    queryKey: ["ticker"],
    queryFn: async () => (await (await fetch("/api/perpl/v1/market-data/ticker")).json()) as { sn: number; d: Record<string, MarketState> },
    refetchInterval: 5000,
  });
  const live = useMemo(
    () =>
      rows.map((r) => {
        const s = data?.d[String(r.id)];
        const m = meta.find((x) => x.id === r.id);
        if (!s || !m) return r;
        const mark = s.mrk / 10 ** m.pd;
        return { ...r, mark, change24h: s.prv ? ((s.mrk - s.prv) / s.prv) * 100 : r.change24h, vol24h: Number(s.dva) / 1e6, oiNotional: (s.oi / 10 ** m.sd) * mark };
      }),
    [rows, meta, data],
  );
  const [sort, setSort] = useState<keyof MarketRow>("vol24h");
  const sorted = [...live].sort((a, b) => (b[sort] as number) - (a[sort] as number));
  const maxVol = Math.max(...live.map((r) => r.vol24h));
  const Th = ({ k, children }: { k: keyof MarketRow; children: React.ReactNode }) => (
    <th className="r" aria-sort={sort === k ? "descending" : "none"}>
      <button onClick={() => setSort(k)} className={sort === k ? "text-ink" : "hover:text-ink-2"}>
        {children}
      </button>
    </th>
  );
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>{L("Market", "Market")}</th>
              <Th k="mark">Mark</Th>
              <Th k="change24h">24h</Th>
              <Th k="vol24h">{L("Volume 24j", "24h volume")}</Th>
              <Th k="oiNotional">{L("Open interest", "Open interest")}</Th>
              <th>{L("Trader long / short", "Traders long / short")}</th>
              <Th k="fundingApr">{L("Funding (APR)", "Funding (APR)")}</Th>
              <Th k="insurance">{L("Dana asuransi", "Insurance fund")}</Th>
              <Th k="maxLev">{L("Lev. maks", "Max lev.")}</Th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              const tot = r.longTraders + r.shortTraders;
              const lp = tot ? (r.longTraders / tot) * 100 : 50;
              return (
                <tr key={r.id}>
                  <td className="font-medium">{r.name}</td>
                  <td className="r">{price(r.mark)}</td>
                  <td className={`r ${r.change24h >= 0 ? "text-up" : "text-down"}`}>{pct(r.change24h, 2, true)}</td>
                  <td className="r">
                    <div className="ml-auto flex w-36 items-center gap-2">
                      <div className="flex-1">
                        <div className="h-1.5 rounded-sm bg-surface-2">
                          <div className="h-1.5 rounded-sm bg-[var(--c1)]" style={{ width: `${(r.vol24h / maxVol) * 100}%` }} />
                        </div>
                      </div>
                      <span className="w-16 text-right">{usd(r.vol24h, { compact: true })}</span>
                    </div>
                  </td>
                  <td className="r">{usd(r.oiNotional, { compact: true })}</td>
                  <td>
                    <div className="flex w-44 items-center gap-2" title={`${r.longTraders} long, ${r.shortTraders} short`}>
                      <span className="num w-7 text-right text-up">{r.longTraders}</span>
                      <div className="flex h-1.5 flex-1 gap-[2px]" aria-hidden>
                        <div className="h-1.5 rounded-sm bg-up" style={{ width: `${lp}%` }} />
                        <div className="h-1.5 flex-1 rounded-sm bg-down" />
                      </div>
                      <span className="num w-7 text-down">{r.shortTraders}</span>
                    </div>
                  </td>
                  <td className={`r ${r.fundingApr > 0 ? "text-up" : r.fundingApr < 0 ? "text-down" : "text-ink-2"}`}>{pct(r.fundingApr, 1, true)}</td>
                  <td className="r">{usd(r.insurance, { compact: true })}</td>
                  <td className="r text-ink-2">{num(r.maxLev, 0)}x</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 px-4 pb-1 text-xs text-ink-3">
        {L(
          "Harga, volume, dan OI diperbarui tiap 5 detik. Funding positif berarti long membayar short. Jumlah trader dihitung dari posisi terbuka onchain.",
          "Price, volume and OI refresh every 5 seconds. Positive funding means longs pay shorts. Trader counts come from open positions onchain.",
        )}{" "}
        {data && <span className="num">Block {data.sn.toLocaleString("en-US")} · {new Date(dataUpdatedAt).toLocaleTimeString("en-GB")}</span>}
      </p>
    </div>
  );
}

/* ----------------------------- liquidation ladder ---------------------------- */

/**
 * Notional that would be liquidated if price moved to each level, from every open position's
 * estimated liquidation price. Longs liquidate below mark, shorts above.
 */
export function LiquidationLadder({ ladder, markets }: { ladder: (readonly [number, number, number, number])[]; markets: { id: number; name: string; mark: number }[] }) {
  const L = useL();
  const [mid, setMid] = useState(markets[0]?.id);
  const m = markets.find((x) => x.id === mid) ?? markets[0];
  const buckets = useMemo(() => {
    if (!m) return [];
    const steps = [-30, -20, -15, -10, -7.5, -5, -3, -2, -1, 0, 1, 2, 3, 5, 7.5, 10, 15, 20, 30];
    const out = steps.slice(0, -1).map((lo, i) => ({ lo, hi: steps[i + 1], long: 0, short: 0 }));
    for (const [id, side, liq, notional] of ladder) {
      if (id !== m.id) continue;
      const d = ((liq - m.mark) / m.mark) * 100;
      const b = out.find((x) => d >= x.lo && d < x.hi);
      if (!b) continue;
      if (side === 0) b.long += notional;
      else b.short += notional;
    }
    return out.reverse();
  }, [ladder, m]);
  const max = Math.max(1, ...buckets.map((b) => b.long + b.short));
  if (!m) return null;
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="Market">
        {markets.map((x) => (
          <button key={x.id} onClick={() => setMid(x.id)} aria-pressed={x.id === m.id} className={`rounded px-2 py-1 text-xs ${x.id === m.id ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink-2"}`}>
            {x.name}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-[96px_1fr_88px] items-center gap-x-3 gap-y-1 text-xs">
        <span className="text-ink-3">{L("Jarak dari mark", "Move from mark")}</span>
        <span />
        <span className="text-right text-ink-3">{L("Notional", "Notional")}</span>
        {buckets.map((b) => {
          const v = b.long + b.short;
          const above = b.lo >= 0;
          return (
            <div key={b.lo} className="contents">
              <span className={`num ${b.lo === 0 || b.hi === 0 ? "text-ink" : "text-ink-3"}`}>
                {above ? `+${b.lo}…+${b.hi}%` : `${b.lo}…${b.hi}%`}
              </span>
              <div className="h-3 rounded-sm bg-surface-2" title={`${usd(v)}: ${b.long ? "long " + usd(b.long) : ""} ${b.short ? "short " + usd(b.short) : ""}`}>
                <div className={`h-3 rounded-sm ${above ? "bg-down" : "bg-up"}`} style={{ width: `${(v / max) * 100}%`, opacity: 0.85 }} />
              </div>
              <span className="num text-right">{v ? usd(v, { compact: true }) : "–"}</span>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-ink-3">
        {L(
          `Mark ${price(m.mark)}. Batang hijau: posisi long yang terlikuidasi bila harga turun ke level itu. Merah: short yang terlikuidasi bila harga naik. Estimasi dari margin terisolasi dan leverage maintenance, tanpa biaya likuidasi.`,
          `Mark ${price(m.mark)}. Green bars: longs liquidated if price falls to that level. Red: shorts liquidated if price rises. Estimated from isolated margin and maintenance leverage, before liquidation fees.`,
        )}
      </p>
    </div>
  );
}

/* --------------------------------- watchlist -------------------------------- */

const WKEY = "copas.watch";
const listeners = new Set<() => void>();
function readWatch(): string[] {
  try {
    return JSON.parse(localStorage.getItem(WKEY) || "[]");
  } catch {
    return [];
  }
}
let cache: string[] | null = null;
const snap = () => (cache ??= readWatch());
function writeWatch(v: string[]) {
  cache = v;
  try {
    localStorage.setItem(WKEY, JSON.stringify(v));
  } catch {
    /* storage blocked: list lives for this tab only */
  }
  listeners.forEach((l) => l());
}
const EMPTY: string[] = [];
export function useWatchlist() {
  const list = useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    snap,
    () => EMPTY,
  );
  return {
    list,
    has: (a: string) => list.includes(a.toLowerCase()),
    toggle: (a: string) => {
      const k = a.toLowerCase();
      writeWatch(list.includes(k) ? list.filter((x) => x !== k) : [...list, k].slice(-12));
    },
  };
}

export function WatchButton({ address }: { address: string }) {
  const L = useL();
  const { has, toggle } = useWatchlist();
  const on = has(address);
  return (
    <button onClick={() => toggle(address)} aria-pressed={on} className={btn.ghost + " py-1.5"}>
      {on ? L("Dipantau", "Watching") : L("Pantau wallet", "Watch wallet")}
    </button>
  );
}

export function Watchlist() {
  const L = useL();
  const { list, toggle } = useWatchlist();
  const [sel, setSel] = useState<string[]>([]);
  useEffect(() => setSel((s) => s.filter((x) => list.includes(x))), [list]);
  if (!list.length)
    return <p className="text-sm text-ink-3">{L("Belum ada wallet dipantau. Buka wallet mana pun lalu tekan Pantau wallet.", "No wallets watched yet. Open any wallet and press Watch wallet.")}</p>;
  return (
    <div>
      <ul className="divide-y divide-[var(--grid)]">
        {list.map((a) => (
          <li key={a} className="flex items-center gap-3 py-2 text-sm">
            <input
              type="checkbox"
              aria-label={L(`Bandingkan ${a}`, `Compare ${a}`)}
              checked={sel.includes(a)}
              onChange={(e) => setSel(e.target.checked ? [...sel, a].slice(-3) : sel.filter((x) => x !== a))}
              className="accent-[var(--gold)]"
            />
            <Link href={`/analytics/wallet/${a}`} className="num flex-1 hover:text-gold-2">
              {isAddress(a) ? short(a) : `#${a}`}
            </Link>
            <button onClick={() => toggle(a)} className="text-xs text-ink-3 hover:text-down">
              {L("Hapus", "Remove")}
            </button>
          </li>
        ))}
      </ul>
      <Link
        href={sel.length >= 2 ? `/analytics/compare?w=${sel.join(",")}` : "#"}
        aria-disabled={sel.length < 2}
        className={`${btn.ghost} mt-3 w-full ${sel.length < 2 ? "pointer-events-none opacity-50" : ""}`}
      >
        {L(`Bandingkan ${sel.length || ""} wallet`, `Compare ${sel.length || ""} wallets`)}
      </Link>
      <p className="mt-2 text-xs text-ink-3">{L("Pilih 2 sampai 3 wallet.", "Pick 2 to 3 wallets.")}</p>
    </div>
  );
}
