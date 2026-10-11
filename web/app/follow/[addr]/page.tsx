import Link from "next/link";
import type { Metadata } from "next";
import { getLeader } from "@/lib/copas/data";
import { getT } from "@/lib/i18n/server";
import { Empty, Source } from "@/components/ui";
import { Seal } from "@/components/Seal";
import { DDMeter, StatusPill } from "@/components/copas";
import { FollowTicket } from "./FollowTicket";

export const metadata: Metadata = { title: "Follow" };

export default async function FollowPage({ params }: { params: Promise<{ addr: string }> }) {
  const { addr } = await params;
  const { t, lang } = await getT();
  const L = (a: string, b: string) => (lang === "id" ? a : b);
  const { leader: l, source } = await getLeader(addr);
  if (!l)
    return (
      <Empty>
        {L("Hanya leader berjaminan yang bisa diikuti. ", "Only bonded leaders can be followed. ")}
        <Link href="/" className="underline">
          {t("nav.leaders")}
        </Link>
      </Empty>
    );
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-5">
        <Seal bond={l.bond + l.underwritten} maxDD={l.maxDD} breached={l.status === "breached"} />
        <div className="flex-1">
          <Link href={`/leader/${l.book}`} className="text-sm text-ink-3 hover:text-ink-2">
            {L("Profil leader", "Leader profile")}
          </Link>
          <h1 className="font-cond text-3xl font-semibold">
            {L("Ikuti", "Follow")} {l.name}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <StatusPill status={l.status} label={t(`status.${l.status}`)} />
            <DDMeter live={l.liveDD} max={l.maxDD} compact />
            {source === "mock" && <Source kind="mock">{t("common.mockNote")}</Source>}
          </div>
        </div>
      </div>
      <FollowTicket leader={l} />
    </div>
  );
}
