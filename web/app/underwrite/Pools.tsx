"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { erc20Abi, type Abi } from "viem";
import { Empty, Panel, btn } from "@/components/ui";
import { DDMeter, StatusPill } from "@/components/copas";
import { useL } from "@/lib/i18n/client";
import { useMeraSession } from "@/lib/mera/MeraProvider";
import { copasPublic, useCopasWrite } from "@/lib/copas/useCopasWrite";
import { copasAbi, deployment, type LeaderStatus } from "@/lib/copas/contracts";
import { num, toAusd, usd } from "@/lib/format";

export type PoolRow = {
  book: `0x${string}`;
  name: string;
  status: LeaderStatus;
  statusLabel: string;
  liveDD: number;
  maxDD: number;
  bond: number;
  pool: `0x${string}`;
  assets: number;
  totalShares: number | null;
  epoch: number;
  breaches: number | null; // indexer rollups; null when it is unreachable
  uwFees: number | null;
  pending: number | null;
};
type Mine = { shares: bigint; value: number; pending: bigint; unlock: number };

const uw = copasAbi.UnderwriterPool as Abi;
const input = "num mt-1 w-full rounded-md border border-line-strong bg-bg px-3 py-2 text-sm focus:border-gold focus:outline-none";

/** Pools table plus the signed-in wallet's stake per pool, read straight from each UnderwriterPool. */
export function Pools({ rows }: { rows: PoolRow[] }) {
  const L = useL();
  const router = useRouter();
  const { address } = useMeraSession();
  const { write, pending, error } = useCopasWrite();
  const [mine, setMine] = useState<Record<string, Mine>>({});
  const [sel, setSel] = useState(rows[0]?.pool);
  const [amt, setAmt] = useState(25);

  const load = useCallback(async () => {
    if (!address || !rows.length) return setMine({});
    const fns = ["sharesOf", "valueOf", "pendingShares", "unlockEpoch"];
    const res = (await copasPublic
      .multicall({ contracts: rows.flatMap((r) => fns.map((f) => ({ address: r.pool, abi: uw, functionName: f, args: [address] }))), allowFailure: false })
      .catch(() => null)) as bigint[] | null;
    if (!res) return;
    setMine(Object.fromEntries(rows.map((r, i) => [r.pool, { shares: res[i * 4], value: Number(res[i * 4 + 1]) / 1e6, pending: res[i * 4 + 2], unlock: Number(res[i * 4 + 3]) }])));
  }, [address, rows]);
  useEffect(() => {
    load();
  }, [load]);

  const done = async (h: unknown) => {
    if (!h) return;
    await load();
    router.refresh();
  };
  const row = rows.find((r) => r.pool === sel);
  const me = sel ? mine[sel] : undefined;

  async function deposit() {
    if (!row || !deployment?.ausd) return;
    const a = toAusd(Number(amt));
    // risky: one passkey prompt; the deposit signs inside the renewed session
    if (!(await write("risky", { address: deployment.ausd, abi: erc20Abi as Abi, functionName: "approve", args: [row.pool, a] }))) return;
    done(await write("small", { address: row.pool, abi: uw, functionName: "deposit", args: [a] }));
  }

  if (!rows.length) return <Panel><Empty>{L("Belum ada leader dengan pool penjamin.", "No leader has an underwriter pool yet.")}</Empty></Panel>;
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <Panel pad={false}>
        <div className="overflow-x-auto" tabIndex={0}>
          <table className="data">
            <thead>
              <tr>
                <th>Leader</th>
                <th>Status</th>
                <th>{L("Drawdown live / janji", "Drawdown live / declared")}</th>
                <th className="r">{L("Jaminan leader (first loss)", "Leader bond (first loss)")}</th>
                <th className="r">{L("Pool penjamin", "Underwriter pool")}</th>
                <th className="r">{L("Antre tarik", "Withdraw queue")}</th>
                <th className="r">{L("Fee ke penjamin", "Fees to underwriters")}</th>
                <th className="r">{L("Breach", "Breaches")}</th>
                <th className="r">{L("Posisimu", "Your stake")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.pool} className={r.pool === sel ? "bg-surface-2" : "cursor-pointer"} onClick={() => setSel(r.pool)}>
                  <td>
                    <Link href={`/leader/${r.book}`} className="hover:text-gold-2">
                      {r.name}
                    </Link>
                  </td>
                  <td>
                    <StatusPill status={r.status} label={r.statusLabel} />
                  </td>
                  <td>
                    <DDMeter live={r.liveDD} max={r.maxDD} compact />
                  </td>
                  <td className="r">{usd(r.bond)}</td>
                  <td className="r">{usd(r.assets)}</td>
                  <td className="r">{r.pending == null ? "–" : `${num(r.pending, 2)} sh`}</td>
                  <td className="r">{r.uwFees == null ? "–" : usd(r.uwFees)}</td>
                  <td className={`r ${r.breaches ? "text-down" : ""}`}>{r.breaches ?? "–"}</td>
                  <td className="r">{mine[r.pool]?.value ? usd(mine[r.pool].value) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {row && (
        <Panel title={`${L("Jamin", "Underwrite")} ${row.name}`} aside={<span className="num">epoch {row.epoch}</span>}>
          {!address ? (
            <p className="text-sm text-ink-3">{L("Masuk dengan passkey untuk menyetor.", "Sign in with your passkey to deposit.")}</p>
          ) : (
            <div className="space-y-4 text-sm">
              <div className="flex justify-between">
                <span className="text-ink-3">{L("Share kamu / total", "Your shares / total")}</span>
                <span className="num">
                  {num(Number(me?.shares ?? 0n) / 1e6, 2)} / {row.totalShares == null ? "–" : num(row.totalShares, 2)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-ink-3">{L("Nilai", "Value")}</span>
                <span className="num">{usd(me?.value ?? 0)}</span>
              </div>
              <label className="block">
                <span className="text-ink-2">{L("Setor (AUSD)", "Deposit (AUSD)")}</span>
                <input type="number" min={1} step={1} value={amt} onChange={(e) => setAmt(Number(e.target.value))} className={input} />
              </label>
              <button disabled={pending || !(amt >= 0.000001 && amt < 1e12) || row.status !== "active"} onClick={deposit} className={btn.primary + " w-full"}>
                {L("Setor ke pool", "Deposit to pool")}
              </button>
              {me && me.pending > 0n ? (
                <div className="space-y-2 border-t border-line pt-3">
                  <p className="text-ink-2">
                    {L(`${num(Number(me.pending) / 1e6, 2)} share menunggu, buka di epoch ${me.unlock}.`, `${num(Number(me.pending) / 1e6, 2)} shares pending, unlocks at epoch ${me.unlock}.`)}
                  </p>
                  <button disabled={pending || row.epoch < me.unlock} onClick={async () => done(await write("risky", { address: row.pool, abi: uw, functionName: "withdraw" }))} className={btn.ghost + " w-full"}>
                    {L("Tarik", "Withdraw")}
                  </button>
                </div>
              ) : (
                me &&
                me.shares > 0n && (
                  <button disabled={pending} onClick={async () => done(await write("risky", { address: row.pool, abi: uw, functionName: "requestWithdraw", args: [me.shares] }))} className={btn.ghost + " w-full"}>
                    {L("Ajukan penarikan semua share", "Request withdrawal of all shares")}
                  </button>
                )
              )}
              {error && <p role="alert" className="text-down">{error}</p>}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
