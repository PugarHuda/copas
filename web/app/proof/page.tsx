import Link from "next/link";
import type { Metadata } from "next";
import { Panel, PageHead, Source } from "@/components/ui";
import { MOCK_PROOF } from "@/lib/mock/copas"; // MOCK until contracts deployed
import { deployment } from "@/lib/copas/contracts";
import { PERPL, copasChain, explorerAddr, explorerTx, monad } from "@/lib/chains";
import { getT } from "@/lib/i18n/server";
import { ago, num, pct, short, usd } from "@/lib/format";
import { Recompute } from "./Recompute";

export const metadata: Metadata = { title: "Proof" };
const NOW = Date.UTC(2026, 9, 4, 3);

export default async function Proof() {
  const { t, lang } = await getT();
  const L = (a: string, b: string) => (lang === "id" ? a : b);
  const addrs: [string, string | undefined, number][] = [
    ["CopasRegistry", deployment?.registry, copasChain.id],
    ["BreachMarket", deployment?.breachMarket, copasChain.id],
    ["AgentLeaderRegistry", deployment?.agentRegistry, copasChain.id],
    ["ERC-8004 identity", deployment?.identity8004, copasChain.id],
    ["Perpl Exchange", PERPL[monad.id].exchange, monad.id],
    ["AUSD", PERPL[monad.id].ausd, monad.id],
  ];
  const b = MOCK_PROOF.breaches[0];
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
        <table className="data">
          <tbody>
            {addrs.map(([name, a, chain]) => (
              <tr key={name}>
                <td>{name}</td>
                <td className="text-ink-3">{chain === 143 ? "Monad" : "Monad testnet"}</td>
                <td className="num">
                  {a ? (
                    <a href={explorerAddr(a, chain)} target="_blank" rel="noreferrer" className="hover:text-gold-2">
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
      </Panel>

      <Panel title={L("Breach dan potongan jaminan", "Breaches and slashes")} aside={<Source kind="mock">LeaderBook.Breached</Source>} pad={false}>
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
            {MOCK_PROOF.breaches.map((x) => (
              <tr key={x.tx}>
                <td>
                  <Link href={`/leader/${x.leader.book}`} className="hover:text-gold-2">
                    {x.leader.name}
                  </Link>
                </td>
                <td>{x.epoch}</td>
                <td className="text-down">{x.reason}</td>
                <td className="r">
                  {num(x.peak, 4)} → {num(x.unit, 4)}
                </td>
                <td className="r text-down">{pct((1 - x.unit / x.peak) * 100, 2)}</td>
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
      </Panel>

      <Panel title={L("Matematika yang bisa direproduksi", "Reproducible math")}>
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
              <span className="text-xs text-ink-3">
                ({b.leader.name}: 1 − {num(b.unit, 4)} / {num(b.peak, 4)} = {pct((1 - b.unit / b.peak) * 100, 2)} &gt; {b.leader.maxDD}%)
              </span>
            </p>
            <p>
              <code className="num text-ink">claimᵢ = min(slash × capᵢ / Σcap, lossᵢ)</code>{" "}
              <span className="text-xs text-ink-3">
                ({usd(b.slash, { dp: 0 })} × cap / {usd(b.capTotal, { dp: 0 })})
              </span>
            </p>
            <p>
              <code className="num text-ink">Σclaim ≤ slash ≤ bond + underwriters</code> <span className="text-xs text-ink-3">{L("invariant, diuji fuzz", "invariant, fuzz-tested")}</span>
            </p>
          </div>
          <Recompute initial={{ equity: b.equity, units: b.units, peak: b.peak, maxDD: b.leader.maxDD, slash: b.slash, capTotal: b.capTotal, cap: 500, loss: 150 }} />
        </div>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title={L("Log DENY policy Privy", "Privy policy DENY log")} aside={<Source kind="mock">Privy</Source>} pad={false}>
          <table className="data">
            <tbody>
              {MOCK_PROOF.privyDeny.map((d) => (
                <tr key={d.id}>
                  <td className="text-ink-3">{ago(d.t, NOW)}</td>
                  <td>{d.wallet}</td>
                  <td className="num">{d.action}</td>
                  <td className="text-down">{d.rule}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-4 py-3 text-xs text-ink-3">{L("Keeper hanya boleh memanggil sync, checkpoint, rollEpoch. Transfer token dan tanda tangan pesan ditolak policy.", "The keeper may only call sync, checkpoint and rollEpoch. Token transfers and message signing are denied by policy.")}</p>
        </Panel>
        <Panel title={L("Signature analisis Kimi", "Kimi analysis signatures")} aside={<Source kind="mock">X-Msh-Request-Nonce</Source>} pad={false}>
          <table className="data">
            <tbody>
              {MOCK_PROOF.kimi.map((k) => (
                <tr key={k.nonce}>
                  <td className="text-ink-3">{ago(k.t, NOW)}</td>
                  <td>{k.leader}</td>
                  <td className="num">{k.nonce}</td>
                  <td className="num">{k.sigHash}</td>
                  <td className={k.verified ? "text-up" : "text-down"}>{k.verified ? L("terverifikasi", "verified") : L("gagal", "failed")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
      <p className="text-xs text-ink-3">
        {L("Analitik Perpl nyata ada di", "Live Perpl analytics are at")}{" "}
        <Link href="/analytics" className="underline">
          /analytics
        </Link>
        . {short(PERPL[monad.id].exchange)}
      </p>
    </div>
  );
}
