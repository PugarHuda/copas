import Link from "next/link";
import type { Metadata } from "next";
import { Empty, Panel, PageHead, Source } from "@/components/ui";
import { deny } from "@/lib/copas/generated/deny";
import { deployment } from "@/lib/copas/contracts";
import { copasBreaches } from "@/lib/copas/indexer";
import { breachInputs, getLeaders } from "@/lib/copas/data";
import { PERPL, copasChain, explorerAddr, explorerTx } from "@/lib/chains";
import { getT } from "@/lib/i18n/server";
import { num, pct, short, usd } from "@/lib/format";
import { Recompute } from "./Recompute";

export const metadata: Metadata = { title: "Proof" };

export default async function Proof() {
  const { t, lang } = await getT();
  const L = (a: string, b: string) => (lang === "id" ? a : b);
  const addrs: [string, string | undefined, number][] = [
    ["CopasRegistry", deployment?.registry, copasChain.id],
    ["BreachMarket", deployment?.breachMarket, copasChain.id],
    ["AgentLeaderRegistry", deployment?.agentRegistry, copasChain.id],
    ["ERC-8004 identity", deployment?.identity8004, copasChain.id],
    ["Perpl Exchange", PERPL[copasChain.id].exchange, copasChain.id],
    ["AUSD", PERPL[copasChain.id].ausd, copasChain.id],
  ];
  const [live, leaders] = deployment?.registry ? await Promise.all([copasBreaches(), getLeaders()]) : [null, null];
  const names = new Map((leaders ?? []).map((l) => [l.book.toLowerCase(), l.name]));
  // worked example = newest breach; without the indexer, a leader still in status Breached is in the epoch that breached
  const target = live?.[0] ?? leaders?.filter((l) => l.status === "breached").map((l) => ({ book: l.book, epoch: l.epoch, claims: [] }))[0];
  const b = target ? await breachInputs(target.book as `0x${string}`, target.epoch, target.claims[0]) : null;
  return (
    <div className="space-y-6">
      <PageHead
        title={t("nav.proof")}
        lede={L(
          "Semua yang menggerakkan uang di Copas bisa dicek: alamat kontrak, setiap breach dan potongan dengan transaksinya, dan rumusnya. Hitung ulang sendiri dari state Perpl.",
          "Everything that moves money in Copas can be checked: contract addresses, every breach and slash with its transaction, and the math. Recompute it yourself from Perpl state.",
        )}
      />
      <Panel title={L("Alamat kontrak", "Contract addresses")} pad={false}>
        <div className="overflow-x-auto">
        <table className="data">
          <tbody>
            {addrs.map(([name, a, chain]) => (
              <tr key={name}>
                <td>{name}</td>
                <td className="text-ink-3">{chain === 143 ? "Monad" : "Monad testnet"}</td>
                <td className="num">
                  {a ? (
                    <a href={explorerAddr(a, chain)} target="_blank" rel="noreferrer" className="whitespace-normal break-all hover:text-gold-2">
                      {a}
                    </a>
                  ) : (
                    <span className="text-ink-3">{L("belum di-deploy", "not deployed yet")}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </Panel>

      <Panel title={L("Breach dan potongan jaminan", "Breaches and slashes")} aside={<Source kind="indexer">LeaderBook.Breached + Claimed</Source>} pad={false}>
        {!live ? (
          <Empty>{L("Indexer tidak merespons. Coba lagi sebentar.", "The indexer did not respond. Try again shortly.")}</Empty>
        ) : !live.length ? (
          <p className="px-4 py-8 text-center text-sm text-ink-3">{L("Belum ada breach. Semua leader masih dalam mandat.", "No breaches yet. Every leader is inside its mandate.")}</p>
        ) : (
        <div className="overflow-x-auto">
        <table className="data">
          <thead>
            <tr>
              <th>Leader</th>
              <th>Epoch</th>
              <th>{L("Alasan", "Reason")}</th>
              <th className="r">{L("Puncak → unit", "Peak → unit")}</th>
              <th className="r">Drawdown</th>
              <th className="r">{L("Dipotong", "Slashed")}</th>
              <th className="r">{L("Diklaim", "Claimed")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {live.map((x) => (
              <tr key={x.tx}>
                <td>
                  <Link href={`/leader/${x.book}`} className="hover:text-gold-2">
                    {names.get(x.book) ?? short(x.book)}
                  </Link>
                </td>
                <td>{x.epoch}</td>
                <td className="text-down">{x.reason}</td>
                <td className="r">
                  {num(x.peak, 4)} → {num(x.unit, 4)}
                </td>
                <td className="r text-down">{pct(x.ddPct, 2)}</td>
                <td className="r">{usd(x.slash)}</td>
                <td className="r">{usd(x.claimed)}</td>
                <td className="r">
                  <a className="text-xs text-ink-3 hover:text-ink-2" href={explorerTx(x.tx, copasChain.id)} target="_blank" rel="noreferrer">
                    tx
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        )}
      </Panel>

      <Panel
        title={L("Matematika yang bisa direproduksi", "Reproducible math")}
        aside={
          b && (
            <Source kind="rpc">
              {short(b.book)} · epoch {b.epoch} · {L("blok", "block")} {b.block}
            </Source>
          )
        }
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-3 text-sm text-ink-2">
            <p>
              <code className="num text-ink">equity = balanceCNS + Σ (depositCNS + pnlCNS)</code>
              <br />
              <span className="text-xs text-ink-3">{L("dibaca dari getAccountById dan getPosition Perpl, blok yang sama", "read from Perpl getAccountById and getPosition, same block")}</span>
            </p>
            <p>
              <code className="num text-ink">u = equity / units</code>, <code className="num text-ink">dd = 1 − u / peak</code>
            </p>
            <p>
              <code className="num text-ink">breach ⇔ dd &gt; maxDD</code>{" "}
              {b && (
                <span className="text-xs text-ink-3">
                  ({names.get(b.book.toLowerCase()) ?? short(b.book)}: 1 − {num(b.equity / b.units, 6)} / {num(b.peak, 6)} = {pct((1 - b.equity / b.units / b.peak) * 100, 3)} &gt; {b.maxDD}%)
                </span>
              )}
            </p>
            <p>
              <code className="num text-ink">claimᵢ = min(slash × capᵢ / Σcap, lossᵢ)</code>{" "}
              {b && (
                <span className="text-xs text-ink-3">
                  ({usd(b.slash)} × {usd(b.cap)} / {usd(b.capTotal)} {L("vs rugi", "vs loss")} {usd(b.loss, { dp: 6 })}
                  {b.vault ? ` · vault ${short(b.vault)}` : ` · ${L("semua follower", "all followers")}`})
                </span>
              )}
            </p>
            <p>
              <code className="num text-ink">Σclaim ≤ slash ≤ bond + underwriters</code> <span className="text-xs text-ink-3">{L("invariant, diuji fuzz", "invariant, fuzz-tested")}</span>
            </p>
          </div>
          {b ? (
            <Recompute initial={{ equity: b.equity, units: b.units, peak: b.peak, maxDD: b.maxDD, slash: b.slash, capTotal: b.capTotal, cap: b.cap, loss: b.loss }} />
          ) : (
            <Empty>
              {target
                ? L("Input breach tidak terbaca dari RPC Monad. Muat ulang untuk mencoba lagi.", "Could not read the breach inputs from the Monad RPC. Reload to try again.")
                : L("Belum ada breach untuk dihitung ulang.", "No breach to recompute yet.")}
            </Empty>
          )}
        </div>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={L("Log DENY policy Privy", "Privy policy DENY log")} aside={deny && <Source kind="live">Privy · {deny.chainId}</Source>} pad={false}>
          {deny ? (
            <div className="overflow-x-auto">
            <table className="data">
              <tbody>
                <tr>
                  <td className="text-ink-3">{deny.at.slice(0, 16).replace("T", " ")}</td>
                  <td className="num">{short(deny.wallet)}</td>
                  <td className="num">{deny.request.call}</td>
                  <td className={deny.outcome === "DENIED" ? "text-down" : "text-warn"}>{deny.outcome === "DENIED" ? deny.error?.code : deny.outcome}</td>
                </tr>
              </tbody>
            </table>
            </div>
          ) : (
            <Empty>{L("Jalankan pnpm privy:deny-demo di keeper.", "Run pnpm privy:deny-demo in keeper.")}</Empty>
          )}
          <p className="px-4 py-3 text-xs text-ink-3">{L("Keeper (server wallet Privy) hanya boleh memanggil sync, checkpoint, rollEpoch di kontrak Copas. Menyentuh AUSD atau Perpl langsung ditolak policy sebelum ditandatangani.", "The keeper (a Privy server wallet) may only call sync, checkpoint and rollEpoch on Copas contracts. Touching AUSD or Perpl directly is refused by policy before signing.")}</p>
        </Panel>
      </div>
      <p className="text-xs text-ink-3">
        {L("Analitik Perpl nyata ada di", "Live Perpl analytics are at")}{" "}
        <Link href="/analytics" className="underline">
          /analytics
        </Link>
        . {L("Copas memakai Perpl Exchange", "Copas trades on Perpl Exchange")}{" "}
        <a className="num underline" href={explorerAddr(PERPL[copasChain.id].exchange, copasChain.id)} target="_blank" rel="noreferrer">
          {short(PERPL[copasChain.id].exchange)}
        </a>{" "}
        ({copasChain.name}).
      </p>
    </div>
  );
}
