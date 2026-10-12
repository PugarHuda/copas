import Link from "next/link";
import { Suspense } from "react";
import { Panel, Segmented, Source, Tabs, Empty, btn } from "@/components/ui";
import { Seal } from "@/components/Seal";
import { DDMeter, StatusPill, protection } from "@/components/copas";
import { getLeaders } from "@/lib/copas/data";
import type { Leader } from "@/lib/copas/contracts";
import { getLeaderboard, LB_PERIODS, type LbPeriod, type LbSort } from "@/lib/perpl/api";
import { getT } from "@/lib/i18n/server";
import { Landing } from "@/components/landing/Landing";
import { num, pct, short, usd } from "@/lib/format";

type SP = Promise<{ tab?: string; p?: string; s?: string }>;

export default async function Home({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const { t, lang } = await getT();
  const L = (a: string, b: string) => (lang === "id" ? a : b);
  const tab = sp.tab === "shadow" ? "shadow" : "bonded";
  const read = await getLeaders();
  const leaders = read ?? [];
  const atStake = leaders.reduce((a, l) => a + l.bond + l.underwritten, 0);
  const aum = leaders.reduce((a, l) => a + l.followerAum, 0);

  const stats = { leaders: leaders.length, bonded: atStake, breached: leaders.filter((l) => l.status === "breached").length, followerAum: aum };
  return (
    <div className="space-y-8">
      <Landing stats={stats} L={L} />
      <section id="leaders" className="grid scroll-mt-20 items-end gap-8 lg:grid-cols-[1fr_auto]">
        <div className="max-w-2xl">
          <h1 className="font-cond text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl">{t("home.title")}</h1>
          <p className="mt-4 text-base leading-relaxed text-ink-2">{t("home.lede")}</p>
        </div>
        <dl className="grid grid-cols-3 gap-6 border-l border-line pl-6 text-sm">
          <div>
            <dt className="text-xs text-ink-3">{L("Jaminan dipertaruhkan", "Bonds at stake")}</dt>
            <dd className="num mt-1 text-xl text-gold-2">{usd(atStake, { dp: 0 })}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">{L("AUM follower", "Follower AUM")}</dt>
            <dd className="num mt-1 text-xl">{usd(aum, { dp: 0 })}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-3">{L("Perlindungan rata-rata", "Average protection")}</dt>
            <dd className="num mt-1 text-xl">{pct(aum ? Math.min(100, (atStake / aum) * 100) : 0, 0)}</dd>
          </div>
        </dl>
      </section>

      <div>
        <Tabs
          active={tab}
          items={[
            { key: "bonded", label: t("home.tabBonded"), href: "/?tab=bonded" },
            { key: "shadow", label: t("home.tabShadow"), href: "/?tab=shadow" },
          ]}
        />
        <div className="mt-4">
          {tab === "bonded" ? (
            <Bonded leaders={read} L={L} t={t} />
          ) : (
            <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-surface" />}>
              <Shadow period={(LB_PERIODS as string[]).includes(sp.p ?? "") ? (sp.p as LbPeriod) : "month"} sort={(["pnl", "roi", "vol"] as string[]).includes(sp.s ?? "") ? (sp.s as LbSort) : "pnl"} L={L} t={t} />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}

type Lx = (a: string, b: string) => string;
type Tx = Awaited<ReturnType<typeof getT>>["t"];

function Bonded({ leaders, L, t }: { leaders: Leader[] | null; L: Lx; t: Tx }) {
  if (!leaders) return <Empty>{L("CopasRegistry tidak terbaca dari RPC Monad. Coba lagi sebentar.", "Could not read CopasRegistry from the Monad RPC. Try again shortly.")}</Empty>;
  if (!leaders.length) return <Empty>{L("Belum ada leader berjaminan. Jadilah yang pertama.", "No bonded leaders yet. Be the first.")}</Empty>;
  const sorted = [...leaders].sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) || b.bond + b.underwritten - (a.bond + a.underwritten));
  return (
    <Panel pad={false} aside={<Source kind="live">{L("Dibaca dari CopasRegistry", "Read from CopasRegistry")}</Source>} title={L("Diurutkan: aktif dulu, lalu jaminan terbesar", "Sorted: active first, then largest stake")}>
      <ul className="divide-y divide-line">
        {sorted.map((l) => {
          const prot = protection(l);
          return (
            <li key={l.book} className="grid grid-cols-1 items-center gap-4 px-4 py-4 md:grid-cols-[auto_1.4fr_1fr_0.8fr_1fr_auto]">
              <Seal bond={l.bond + l.underwritten} maxDD={l.maxDD} breached={l.status === "breached"} size="sm" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/leader/${l.book}`} className="font-medium hover:text-gold-2">
                    {l.name}
                  </Link>
                  <StatusPill status={l.status} label={t(`status.${l.status}`)} />
                  {l.agent && <span className="text-xs text-ink-3">AI agent{l.agent.erc8004Id ? ` · ERC-8004 #${l.agent.erc8004Id}` : ""}</span>}
                </div>
                <div className="mt-1 text-xs text-ink-3">
                  {l.markets.join(", ")} · {L("lev. maks", "max lev.")} {l.maxLeverage}x · fee {l.feePct}% · {L("epoch", "epoch")} {l.epoch}
                </div>
                <div className="mt-1 text-xs text-ink-3">
                  {L("Jaminan", "Bond")} <span className="num text-ink-2">{usd(l.bond, { dp: 0 })}</span>
                  {l.underwritten > 0 && (
                    <>
                      {" + "}
                      {L("penjamin", "underwriters")} <span className="num text-ink-2">{usd(l.underwritten, { dp: 0 })}</span>
                    </>
                  )}
                </div>
              </div>
              <div>
                <div className="mb-1 text-xs text-ink-3">{t("lb.dd")}</div>
                <DDMeter live={l.liveDD} max={l.maxDD} />
              </div>
              <div>
                <div className="text-xs text-ink-3">{t("lb.unit")}</div>
                <div className="num">
                  {num(l.unitPrice, 3)} <span className={`text-xs ${l.returnTotal >= 0 ? "text-up" : "text-down"}`}>{pct(l.returnTotal, 1, true)} {L("sejak awal", "since start")}</span>
                </div>
              </div>
              <div>
                <div className="text-xs text-ink-3">
                  {t("lb.aum")} · {t("lb.protection")}
                </div>
                <div className="num">
                  {usd(l.followerAum, { dp: 0 })} <span className={prot < 25 ? "text-warn" : "text-ink-2"}>· {pct(prot, 0)}</span>
                </div>
                <div className="text-[11px] text-ink-3">{t("lb.protectionHint")}</div>
              </div>
              <Link href={`/follow/${l.book}`} aria-disabled={l.status !== "active"} className={`${l.status === "active" ? btn.primary : btn.ghost + " pointer-events-none opacity-50"} py-1.5`}>
                {t("common.follow")}
              </Link>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

async function Shadow({ period, sort, L, t }: { period: LbPeriod; sort: LbSort; L: Lx; t: Tx }) {
  const rows = await getLeaderboard(period, sort).catch(() => null);
  const q = (k: string, v: string) => `/?${new URLSearchParams({ tab: "shadow", p: period, s: sort, [k]: v })}`;
  return (
    <Panel
      pad={false}
      title={<span className="font-normal text-ink-2">{t("home.shadowNote")}</span>}
      aside={
        <>
          <Segmented active={period} items={LB_PERIODS.map((p) => ({ key: p, label: t(`period.${p}`), href: q("p", p) }))} />
          <Segmented
            active={sort}
            items={[
              { key: "pnl", label: "PnL", href: q("s", "pnl") },
              { key: "roi", label: "ROI", href: q("s", "roi") },
              { key: "vol", label: L("Volume", "Volume"), href: q("s", "vol") },
            ]}
          />
        </>
      }
    >
      {!rows ? (
        <Empty>{L("Leaderboard Perpl tidak merespons. Coba lagi sebentar.", "The Perpl leaderboard did not respond. Try again shortly.")}</Empty>
      ) : (
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>{t("common.rank")}</th>
                <th>{t("common.address")}</th>
                <th className="r">PnL</th>
                <th className="r">ROI</th>
                <th className="r">{t("common.volume")}</th>
                <th className="r">{L("Status", "Status")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows
                .filter((r) => r.volume > 0)
                .slice(0, 50)
                .map((r) => (
                  <tr key={r.address}>
                    <td className="text-ink-3">{r.rank}</td>
                    <td>
                      <Link href={`/leader/${r.address}`} className="num hover:text-gold-2">
                        {short(r.address)}
                      </Link>
                    </td>
                    <td className={`r ${r.pnl >= 0 ? "text-up" : "text-down"}`}>{usd(r.pnl, { sign: true })}</td>
                    <td className="r">{pct(r.roi, 1, true)}</td>
                    <td className="r text-ink-2">{usd(r.volume, { compact: true })}</td>
                    <td className="r">
                      <span className="text-xs text-warn">{L("Tanpa jaminan", "No bond")}</span>
                    </td>
                    <td className="r">
                      <Link href={`/analytics/wallet/${r.address}`} className="text-xs text-ink-3 hover:text-ink-2">
                        {L("Analitik", "Analytics")}
                      </Link>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          <p className="px-4 py-3 text-xs text-ink-3">
            <Source kind="live">GET app.perpl.xyz/api/v1/trading/leaderboard/{period}/{sort}</Source>{" "}
            {L("ROI Perpl = PnL / max(100, equity awal + transfer masuk).", "Perpl ROI = PnL / max(100, starting equity + inbound transfers).")}
          </p>
        </div>
      )}
    </Panel>
  );
}
