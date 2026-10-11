import Link from "next/link";
import type { Metadata } from "next";
import { Panel, PageHead, Source } from "@/components/ui";
import { DDMeter, StatusPill } from "@/components/copas";
import { MOCK_UW } from "@/lib/mock/copas"; // MOCK until contracts deployed
import { getT } from "@/lib/i18n/server";
import { pct, usd } from "@/lib/format";

export const metadata: Metadata = { title: "Underwrite" };

export default async function Underwrite() {
  const { t, lang } = await getT();
  const L = (a: string, b: string) => (lang === "id" ? a : b);
  return (
    <div className="space-y-6">
      <PageHead
        title={t("nav.underwrite")}
        lede={L(
          "Tambahkan AUSD ke jaminan seorang leader dan terima 30% dari fee kinerjanya. Bila leader melanggar, jaminan leader dipotong lebih dulu, lalu pool penjamin secara pro-rata.",
          "Add AUSD to a leader's bond and earn 30% of their performance fees. If the leader breaks the mandate, the leader's own bond is slashed first, then the underwriter pool pro-rata.",
        )}
      >
        <Source kind="mock">{t("common.mockNote")}</Source>
      </PageHead>
      <Panel pad={false}>
        <div className="overflow-x-auto">
          <table className="data">
            <thead>
              <tr>
                <th>Leader</th>
                <th>{t("common.status")}</th>
                <th>{L("Drawdown live / janji", "Drawdown live / declared")}</th>
                <th className="r">{L("Jaminan leader (first loss)", "Leader bond (first loss)")}</th>
                <th className="r">{L("Pool penjamin", "Underwriter pool")}</th>
                <th className="r">{L("APR fee historis", "Historical fee APR")}</th>
                <th className="r">{L("Breach", "Breaches")}</th>
                <th className="r">{L("Posisimu", "Your stake")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {MOCK_UW.map((u) => (
                <tr key={u.leader.book}>
                  <td>
                    <Link href={`/leader/${u.leader.book}`} className="hover:text-gold-2">
                      {u.leader.name}
                    </Link>
                  </td>
                  <td>
                    <StatusPill status={u.leader.status} label={t(`status.${u.leader.status}`)} />
                  </td>
                  <td>
                    <DDMeter live={u.leader.liveDD} max={u.leader.maxDD} compact />
                  </td>
                  <td className="r">{usd(u.leader.bond, { dp: 0 })}</td>
                  <td className="r">{usd(u.pool, { dp: 0 })}</td>
                  <td className="r">{pct(u.feeApr, 1)}</td>
                  <td className={`r ${u.breaches ? "text-down" : ""}`}>{u.breaches}</td>
                  <td className="r">{u.myStake ? usd(u.myStake, { dp: 0 }) : "–"}</td>
                  <td className="r">
                    <Link href={`/market/${u.leader.book}`} className="text-xs text-ink-3 hover:text-ink-2">
                      {L("Pasar DOWN", "DOWN market")}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title={L("Cara kerja risiko penjamin", "How underwriter risk works")}>
        <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink-2">
          <li>{L("Deposit mencetak share cpUW per leader. Penarikan butuh satu epoch dan tetap bisa dipotong selama menunggu.", "Deposits mint per-leader cpUW shares. Withdrawals take one epoch and stay slashable while pending.")}</li>
          <li>{L("Kerugian maksimal = seluruh setoranmu bila breach memakan habis jaminan leader.", "Worst case = your whole deposit, if a breach exhausts the leader's bond.")}</li>
          <li>{L("Ingin lindung nilai tanpa mengunci modal? Beli token DOWN leader tersebut.", "Want a hedge without locking capital? Buy that leader's DOWN token.")}</li>
        </ul>
      </Panel>
    </div>
  );
}
