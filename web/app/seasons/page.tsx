import Link from "next/link";
import type { Metadata } from "next";
import { Empty, Panel, PageHead, Source, Stat, StatRow } from "@/components/ui";
import { getLeaders } from "@/lib/copas/data";
import { WEEK, seasonBoard, weekStart } from "@/lib/copas/indexer";
import { pct, short, usd } from "@/lib/format";

export const metadata: Metadata = { title: "Seasons" };

type SP = Promise<{ w?: string }>;

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
// testnet sizes are cents: show 4 decimals below $1 so a real loss never reads as $0.00
const amt = (v: number, sign = true) => usd(v, { sign, dp: Math.abs(v) < 1 && v !== 0 ? 4 : 2 });
const tone = (v: number) => (v > 0 ? "text-up" : v < 0 ? "text-down" : "text-ink-2");

export default async function Seasons({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const now = Math.floor(Date.now() / 1000);
  const current = weekStart(now);
  const asked = sp.w && /^\d{4}-\d{2}-\d{2}$/.test(sp.w) ? Date.parse(`${sp.w}T00:00:00Z`) / 1000 : NaN;
  const from = Number.isFinite(asked) ? Math.min(weekStart(asked), current) : current;
  const to = from + WEEK;
  const [board, leaders] = await Promise.all([seasonBoard(from, to), getLeaders()]);
  const names = new Map((leaders ?? []).map((l) => [l.book.toLowerCase(), l]));
  // a leader nobody copied has no follower result: rank it after every leader with copying vaults, not above the ones with a small loss
  const rows = (board?.rows ?? []).sort((a, b) => Number(b.vaults > 0) - Number(a.vaults > 0) || b.net - a.net || b.bond - a.bond);
  const first = board ? weekStart(board.firstAt) : from;
  const season = Math.round((from - first) / WEEK) + 1; // < 1 = before the first leader existed
  const label = (n: number) => (n < 1 ? "Pre-season" : `Season ${n}`);
  const next = Math.max(from + WEEK, first); // from any pre-season week, "next" is Season 1, not the following empty week
  const nextSeason = Math.round((next - first) / WEEK) + 1;
  const total = rows.reduce((a, r) => ({ net: a.net + r.net, slash: a.slash + r.slashPaid, breaches: a.breaches + r.breaches, bond: a.bond + (names.get(r.book)?.bond ?? r.bond) }), { net: 0, slash: 0, breaches: 0, bond: 0 });
  const active = rows.some((r) => r.fills || r.slashPaid || r.breaches || r.perfFees);

  return (
    <div className="space-y-6">
      <PageHead
        title="Seasons"
        lede="A weekly league ranked by what followers actually took home, not by leader PnL. A leader who wins big while followers get bad fills, or who breaks the mandate, ranks below one whose followers came out ahead."
      >
        <nav className="flex items-center gap-2 text-sm" aria-label="Season">
          {from > first && (
            <Link href={`/seasons?w=${day(from - WEEK)}`} className="rounded border border-line-strong px-2 py-1 text-ink-2 hover:text-ink">
              ← {label(season - 1)}
            </Link>
          )}
          <span className="micro rounded-full bg-ink px-3 py-1.5 font-medium text-bg">
            {label(season)} · {day(from)} – {day(to - 86_400)}
          </span>
          {from < current && (
            <Link href={`/seasons?w=${day(next)}`} className="rounded border border-line-strong px-2 py-1 text-ink-2 hover:text-ink">
              {label(nextSeason)} →
            </Link>
          )}
        </nav>
      </PageHead>

      {!board ? (
        <Panel>
          <Empty>The Copas indexer did not respond, so this season cannot be computed. Try again shortly.</Empty>
        </Panel>
      ) : (
        <>
          {rows.length > 0 && (
            <Panel>
              <StatRow>
                <Stat label="Followers' net result" value={amt(total.net)} tone={tone(total.net)} />
                <Stat label="Slashes paid to followers" value={amt(total.slash, false)} />
                <Stat label="Breaches this season" value={total.breaches} />
                <Stat label="Bond at stake now" value={usd(total.bond, { dp: 0 })} />
                <Stat label="Leaders" value={rows.length} />
                <Stat label={from === current ? "Ends" : "Ended"} value={day(to)} sub="00:00 UTC" />
              </StatRow>
            </Panel>
          )}

          <Panel pad={false} title="Ranked by followers' net result" aside={<Source kind="indexer">Envio indexer · chain 10143 · Fill, CopyFill, Claim, Breach, Epoch, Checkpoint</Source>}>
            {!rows.length ? (
              <Empty>No leaders existed in this season.</Empty>
            ) : (
              <div className="overflow-x-auto">
                <table className="data">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Leader</th>
                      <th className="r">Followers&apos; net</th>
                      <th className="r">Copy PnL</th>
                      <th className="r">Fees</th>
                      <th className="r">Slash received</th>
                      <th className="r">Copying vaults</th>
                      <th className="r">Leader unit</th>
                      <th className="r">Breaches</th>
                      <th className="r">Bond</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const l = names.get(r.book);
                      const unitRet = r.unitStart && r.unitEnd ? (r.unitEnd / r.unitStart - 1) * 100 : null;
                      return (
                        <tr key={r.book}>
                          <td className="text-ink-3">{i + 1}</td>
                          <td>
                            <Link href={`/leader/${r.book}`} className="hover:text-gold-2">
                              {l?.name ?? short(r.book)}
                            </Link>
                            {l && <span className="ml-2 text-xs capitalize text-ink-3">{l.status}</span>}
                          </td>
                          <td className={`r num font-medium ${tone(r.net)}`}>{r.fills || r.slashPaid || r.perfFees ? amt(r.net) : "–"}</td>
                          <td className={`r num ${tone(r.tradePnl)}`}>{r.fills ? amt(r.tradePnl) : "–"}</td>
                          <td className="r num text-ink-2">{r.fees || r.perfFees ? amt(-(r.fees + r.perfFees)) : "–"}</td>
                          <td className="r num text-up">{r.slashPaid ? amt(r.slashPaid) : "–"}</td>
                          <td className="r num">
                            {r.vaults}
                            <span className="text-xs text-ink-3"> · {r.fills} {r.fills === 1 ? "fill" : "fills"}</span>
                          </td>
                          <td className={`r num ${tone(unitRet ?? 0)}`}>{unitRet == null ? "–" : pct(unitRet, Math.abs(unitRet) < 1 ? 3 : 1, true)}</td>
                          <td className={`r num ${r.breaches ? "text-down" : "text-ink-3"}`}>{r.breaches}</td>
                          <td className="r num">{usd(l ? l.bond : r.bond, { dp: 0 })}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {!active && <p className="px-4 py-3 text-xs text-ink-3">No copy fills, claims or breaches in this season yet: every follower result is zero so far.</p>}
              </div>
            )}
          </Panel>
        </>
      )}

      <Panel title="How a season is scored">
        <div className="space-y-3 text-sm leading-relaxed text-ink-2">
          <p>A season is one calendar week, Monday 00:00 UTC to the next Monday. For each leader, over the season:</p>
          <pre className="num overflow-x-auto rounded-md border border-line bg-bg p-3 text-xs text-ink">
            {`followers' net = Σ follower-vault fills (realizedPnl − fee)
               + Σ slash claims paid out of this leader's bond
               − Σ performance fees of this leader's epochs that ended in the season`}
          </pre>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              Fills are the Perpl fills of follower vaults (indexer <code>Fill</code>). A fill belongs to the leader of the <code>CopyFill</code> (Synced event) in the same
              transaction; vaults only trade through <code>sync</code>, so every copy is attributed. PnL is realized: an open copy counts its entry fee now and its PnL when it closes.
            </li>
            <li>Slash received is the <code>Claim</code> rows of this leader&apos;s breaches, paid to followers in the season. Performance fees are <code>Epoch.feesToLeader + feesToUnderwriters</code>.</li>
            <li>Leader unit is the LeaderBook unit price change over the season (last checkpoint before the start vs. the latest checkpoint before the end), shown for contrast: it is the leader&apos;s own result.</li>
            <li>Bond is the live <code>LeaderBook.bond()</code>. Leaders with no copying vault rank last. Ties rank by bond.</li>
          </ul>
        </div>
      </Panel>
    </div>
  );
}
