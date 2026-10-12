import type { Metadata } from "next";
import Link from "next/link";
import { unstable_cache } from "next/cache";
import { createPublicClient, type Abi } from "viem";
import { Panel, Source, Stat, StatRow } from "@/components/ui";
import { getLeaderboard, type LbPeriod } from "@/lib/perpl/api";
import { copasAbi, deployment } from "@/lib/copas/contracts";
import { copasChain, rpcTransport } from "@/lib/chains";
import { num, pct, short, usd } from "@/lib/format";

export const metadata: Metadata = { title: "Would Copas have saved you?" };
export const revalidate = 300;

const PERIODS: { k: LbPeriod; label: string }[] = [
  { k: "week", label: "7 days" },
  { k: "month", label: "30 days" },
  { k: "all", label: "All time" },
];

// A registry parameter that changes by governance only: one RPC read an hour, not one per request (the public testnet RPC rate-limits).
// unstable_cache stores only resolved values, so a failed read is retried on the next request.
const bondRatio = unstable_cache(
  async () => {
    if (!deployment?.registry) return null;
    const client = createPublicClient({ chain: copasChain, transport: rpcTransport(copasChain) });
    return Number(await client.readContract({ address: deployment.registry, abi: copasAbi.CopasRegistry as Abi, functionName: "bondRatioBps" }));
  },
  ["copas-bond-ratio-bps", String(copasChain.id)],
  { revalidate: 3600 },
);

/** Live Perpl leaderboard: who lost, how much, and what the registry's real bond rule would have returned to a copier. */
export default async function SavedPage({ searchParams }: { searchParams: Promise<{ p?: string; c?: string }> }) {
  const sp = await searchParams;
  const period = (PERIODS.find((x) => x.k === sp.p)?.k ?? "month") as LbPeriod;
  const c = Math.round(Number(sp.c)); // "", "abc" → default; 0, negative, huge → clamped
  const capital = sp.c && Number.isFinite(c) ? Math.min(1_000_000, Math.max(10, c)) : 1000;
  const [rows, bondBps] = await Promise.all([
    getLeaderboard(period, "pnl").catch(() => null),
    bondRatio().catch(() => null),
  ]);

  if (!rows) return <p className="text-sm text-down">Perpl leaderboard unreachable right now. Try again in a minute.</p>;
  const active = rows.filter((r) => r.pnl !== 0);
  const losers = active.filter((r) => r.pnl < 0);
  const lost = -losers.reduce((a, r) => a + r.pnl, 0);
  const won = active.filter((r) => r.pnl > 0).reduce((a, r) => a + r.pnl, 0);
  const worst = [...losers].sort((a, b) => a.pnl - b.pnl).slice(0, 10);
  const share = active.length ? (losers.length / active.length) * 100 : 0;
  // Copas rule (CopasRegistry.bondRatioBps): a leader must bond ≥ ratio × follower capacity, slashed pro-rata, capped at real loss.
  const ratio = (bondBps ?? 1000) / 10_000;
  const covered = (lossPct: number) => Math.min(capital * Math.min(1, lossPct / 100), capital * ratio);

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <p className="micro text-ink-3">Reality check · live Perpl data</p>
        <h1 className="display text-[clamp(44px,7vw,96px)]">Would Copas have saved you?</h1>
        <p className="max-w-2xl text-ink-2">
          Every trader on Perpl&apos;s public leaderboard, right now. Copying any of them today means taking their losses with no recourse. On Copas the leader&apos;s bond pays you back first.
        </p>
        <nav className="flex flex-wrap gap-2" aria-label="Period">
          {PERIODS.map((p) => (
            <Link key={p.k} href={`/saved?p=${p.k}&c=${capital}`} aria-current={p.k === period ? "page" : undefined} className={`micro rounded-full px-3 py-1.5 font-medium ${p.k === period ? "bg-ink text-bg" : "border border-line-strong text-ink-2 hover:text-ink"}`}>
              {p.label}
            </Link>
          ))}
        </nav>
      </header>

      <Panel aside={<Source kind="live">app.perpl.xyz · leaderboard/{period}/pnl</Source>}>
        <StatRow>
          <Stat label="Traders who lost money" value={`${num(share, 0)}%`} sub={`${losers.length} of ${active.length} with non-zero PnL`} tone="text-down" />
          <Stat label="Total lost by losing traders" value={usd(lost, { dp: 0 })} tone="text-down" />
          <Stat label="Total won by winning traders" value={usd(won, { dp: 0 })} tone="text-up" />
          <Stat label="Copas bond rule" value={bondBps != null ? `${num(ratio * 100, 0)}% of capacity` : "–"} sub="CopasRegistry.bondRatioBps, testnet" />
        </StatRow>
      </Panel>

      <Panel title="The 10 biggest losers: what copying them would have cost" pad={false} aside={<span className="micro text-ink-3">your capital: {usd(capital, { dp: 0 })}</span>}>
        <form className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 text-sm" action="/saved">
          <input type="hidden" name="p" value={period} />
          <label htmlFor="c" className="text-ink-3">
            Capital you copy with (AUSD)
          </label>
          <input id="c" name="c" type="number" min={10} max={1000000} step={1} defaultValue={capital} className="num w-32 rounded-md border border-line-strong bg-surface px-2 py-1" />
          <button className="micro rounded-full bg-gold px-3 py-1.5 font-semibold text-gold-ink">Recalculate</button>
        </form>
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Trader</th>
                <th className="r">PnL</th>
                <th className="r">ROI</th>
                <th className="r">You lose copying</th>
                <th className="r">Copas bond returns</th>
                <th className="r">Net</th>
              </tr>
            </thead>
            <tbody>
              {worst.map((r) => {
                const lossPct = Math.max(0, -r.roi);
                const loss = capital * Math.min(1, lossPct / 100);
                const back = covered(lossPct);
                return (
                  <tr key={r.address}>
                    <td>
                      <Link className="num underline-offset-2 hover:underline" href={`/analytics/wallet/${r.address}`}>
                        {short(r.address)}
                      </Link>
                    </td>
                    <td className="num r text-down">{usd(r.pnl, { dp: 0 })}</td>
                    <td className="num r">{pct(r.roi, 1)}</td>
                    <td className="num r text-down">{usd(-loss, { dp: 2 })}</td>
                    <td className="num r text-up">{usd(back, { sign: true, dp: 2 })}</td>
                    <td className="num r">{usd(back - loss, { dp: 2 })}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="px-4 py-3 text-xs leading-relaxed text-ink-3">
          Loss = your capital × the trader&apos;s ROI for the period (copying at the same ratio). Returned = min(loss, bond share), where the bond share is capital × bond ratio, the minimum the registry forces a leader to post per unit of follower capacity, slashed pro-rata on a mandate breach (LeaderBook.claimFor). A stricter mandate breaches earlier, so the real loss before the slash is usually smaller than the full-period ROI shown here.
        </p>
      </Panel>

      <div className="flex flex-wrap gap-2">
        <Link href="/#leaders" className="micro rounded-full bg-gold px-4 py-2.5 font-semibold text-gold-ink">
          Follow a bonded leader →
        </Link>
        <Link href="/proof" className="micro rounded-full border border-line-strong px-4 py-2.5 font-semibold text-ink-2 hover:text-ink">
          See a real slash on testnet
        </Link>
      </div>
    </div>
  );
}
