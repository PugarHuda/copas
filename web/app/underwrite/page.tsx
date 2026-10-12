import type { Metadata } from "next";
import { createPublicClient, http, type Abi } from "viem";
import { Empty, Panel, PageHead, Source } from "@/components/ui";
import { getLeaders } from "@/lib/copas/data";
import { leaderStats } from "@/lib/copas/indexer";
import { copasAbi } from "@/lib/copas/contracts";
import { copasChain } from "@/lib/chains";
import { getT } from "@/lib/i18n/server";
import { Pools, type PoolRow } from "./Pools";

export const metadata: Metadata = { title: "Underwrite" };

const client = createPublicClient({ chain: copasChain, transport: http() });

export default async function Underwrite() {
  const { t, lang } = await getT();
  const L = (a: string, b: string) => (lang === "id" ? a : b);
  const [leaders, stats] = await Promise.all([getLeaders(), leaderStats()]);
  const withPool = (leaders ?? []).filter((l) => l.pool);
  const shares = (await client
    .multicall({ contracts: withPool.map((l) => ({ address: l.pool!, abi: copasAbi.UnderwriterPool as Abi, functionName: "totalShares" })), allowFailure: false })
    .catch(() => null)) as bigint[] | null;
  const rows: PoolRow[] = withPool.map((l, i) => {
    const s = stats?.get(l.book.toLowerCase());
    return {
      book: l.book,
      name: l.name,
      status: l.status,
      statusLabel: t(`status.${l.status}`),
      liveDD: l.liveDD,
      maxDD: l.maxDD,
      bond: l.bond,
      pool: l.pool!,
      assets: l.underwritten,
      totalShares: shares ? Number(shares[i]) / 1e6 : null,
      epoch: l.epoch,
      breaches: s?.breaches ?? null,
      uwFees: s?.uwFees ?? null,
      pending: s?.uwPendingShares ?? null,
    };
  });
  return (
    <div className="space-y-6">
      <PageHead
        title={t("nav.underwrite")}
        lede={L(
          "Tambahkan AUSD ke jaminan seorang leader dan terima 30% dari fee kinerjanya. Bila leader melanggar, jaminan leader dipotong lebih dulu, lalu pool penjamin secara pro-rata.",
          "Add AUSD to a leader's bond and earn 30% of their performance fees. If the leader breaks the mandate, the leader's own bond is slashed first, then the underwriter pool pro-rata.",
        )}
      >
        <Source kind="live">UnderwriterPool{stats ? " + Envio" : ""}</Source>
      </PageHead>
      {!leaders ? (
        <Panel>
          <Empty>{L("CopasRegistry tidak terbaca dari RPC Monad. Coba lagi sebentar.", "Could not read CopasRegistry from the Monad RPC. Try again shortly.")}</Empty>
        </Panel>
      ) : (
        <Pools rows={rows} />
      )}
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
