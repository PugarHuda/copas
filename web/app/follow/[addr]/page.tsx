import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getLeader, maxVaultDeposit, minVaultOpen } from "@/lib/copas/data";
import { getT } from "@/lib/i18n/server";
import { isAddress, short } from "@/lib/format";
import { Empty, Panel, PageHead, Unreachable, btn } from "@/components/ui";
import { Seal } from "@/components/Seal";
import { DDMeter, StatusPill } from "@/components/copas";
import { FollowTicket } from "./FollowTicket";

type P = Promise<{ addr: string }>;

export async function generateMetadata({ params }: { params: P }): Promise<Metadata> {
  const { addr } = await params;
  const l = isAddress(addr) ? await getLeader(addr) : null;
  return { title: l ? `Follow ${l.name}` : "Follow" };
}

export default async function FollowPage({ params }: { params: P }) {
  const { addr } = await params;
  if (!isAddress(addr)) notFound();
  const { t, lang } = await getT();
  const L = (a: string, b: string) => (lang === "id" ? a : b);
  const [l, maxDeposit, minDeposit] = await Promise.all([getLeader(addr), maxVaultDeposit(), minVaultOpen()]);
  if (l === undefined) return <Unreachable title={L(`Ikuti ${short(addr)}`, `Follow ${short(addr)}`)}>{L("RPC Monad tidak merespons. Muat ulang sebentar lagi.", "The Monad RPC did not respond. Reload in a moment.")}</Unreachable>;
  if (!l)
    return (
      <div className="space-y-6">
        <PageHead title={L(`Ikuti ${short(addr)}`, `Follow ${short(addr)}`)} />
        <Panel>
          <Empty>
            {L("Hanya leader berjaminan yang bisa diikuti. ", "Only bonded leaders can be followed. ")}
            <Link href={`/leader/${addr}`} className="underline">
              {L("Lihat performa Perpl-nya", "See their Perpl record")}
            </Link>
            {" · "}
            <Link href="/" className="underline">
              {t("nav.leaders")}
            </Link>
          </Empty>
        </Panel>
      </div>
    );
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-5">
        <Seal bond={l.bond + l.underwritten} maxDD={l.maxDD} breached={l.status === "breached"} />
        <div className="min-w-0 flex-1">
          <Link href={`/leader/${l.book}`} className="text-sm text-ink-3 hover:text-ink-2">
            {L("Profil leader", "Leader profile")}
          </Link>
          <h1 className="break-words font-cond text-3xl font-semibold">
            {L("Ikuti", "Follow")} {l.name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <StatusPill status={l.status} label={t(`status.${l.status}`)} />
            <DDMeter live={l.liveDD} max={l.maxDD} compact />
          </div>
        </div>
      </div>
      {l.status === "active" ? (
        <FollowTicket leader={l} maxDeposit={maxDeposit} minDeposit={minDeposit} />
      ) : (
        <Panel title={L("Leader ini tidak bisa diikuti", "This leader can't be followed")}>
          <p className="max-w-2xl text-sm text-ink-2">
            {l.status === "breached"
              ? L(
                  `${l.name} melanggar mandat di epoch ${l.epoch}: jaminannya dipotong dan dibayarkan ke follower. LeaderBook yang melanggar tidak menerima follower baru.`,
                  `${l.name} broke its mandate in epoch ${l.epoch}: the bond was slashed and paid to followers. A breached LeaderBook takes no new followers.`,
                )
              : l.status === "unbonded"
                ? L(
                    `${l.name} sudah atau sedang menarik jaminannya, jadi tidak ada yang dipertaruhkan untuk melindungi follower baru.`,
                    `${l.name} has withdrawn or is withdrawing its bond, so nothing is at stake to protect a new follower. Copas only lets you follow leaders with an active bond.`,
                  )
                : L(`LeaderBook ${l.name} sudah ditutup.`, `${l.name}'s LeaderBook is closed and takes no new followers.`)}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link href={`/leader/${l.book}`} className={btn.ghost}>
              {L("Lihat profil dan checkpoint", "See profile and checkpoints")}
            </Link>
            {l.status === "breached" && (
              <Link href="/proof" className={btn.ghost}>
                {L("Bukti breach", "Breach proof")}
              </Link>
            )}
            <Link href="/" className={btn.primary}>
              {L("Pilih leader aktif", "Pick an active leader")}
            </Link>
          </div>
        </Panel>
      )}
    </div>
  );
}
