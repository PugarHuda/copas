"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Panel, Source, btn } from "@/components/ui";
import { useL } from "@/lib/i18n/client";
import { useMeraSession } from "@/lib/mera/MeraProvider";
import { explorerTx, copasChain } from "@/lib/chains";
import { short } from "@/lib/format";

type Check = { vault: `0x${string}`; leader: string; status: string; ddPct: number; maxDDPct: number; consentOk: boolean | null; reason: string | null };
type Guard = { delegated: boolean; since: string | null; checks: Check[] };
type Acted = { vault: string; reason: string; hash?: string; status?: string; error?: string };

/**
 * Dynamic delegated access for email (embedded wallet) users: Copas' server holds a delegated MPC share that can sign
 * exactly one call, unfollow() on your own vault, and only when a protective rule holds. You can revoke it any time.
 */
export function DynamicGuard({ vault }: { vault: `0x${string}` }) {
  const L = useL();
  const router = useRouter();
  const { kind, address } = useMeraSession();
  const [g, setG] = useState<Guard | null>(null);
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<string>();
  const [acted, setActed] = useState<Acted[]>([]);

  const load = useCallback(async () => {
    if (!address) return;
    const r = await fetch(`/api/dynamic/guard?address=${address}`, { cache: "no-store" }).then((x) => x.json()).catch(() => null);
    if (r && !r.error) setG(r);
  }, [address]);
  useEffect(() => {
    load();
  }, [load]);

  if (kind !== "dynamic" || !address) return null;

  const run = (label: string, f: () => Promise<void>) => async () => {
    setBusy(label);
    setMsg(undefined);
    try {
      await f();
    } catch (e) {
      setMsg(e instanceof Error ? e.message.split("\n")[0] : String(e));
    } finally {
      setBusy(undefined);
    }
  };
  // the webhook lands a moment after the reshare; poll until the server has it
  const waitFor = async (want: boolean) => {
    for (let i = 0; i < 15; i++) {
      const r = await fetch(`/api/dynamic/guard?address=${address}`, { cache: "no-store" }).then((x) => x.json());
      setG(r);
      if (r.delegated === want) return;
      await new Promise((ok) => setTimeout(ok, 2000));
    }
    throw new Error(want ? "Delegated in Dynamic, but the server has not received the share yet. Refresh in a minute." : "Revoked in Dynamic; the server still lists the share. Refresh in a minute.");
  };

  return (
    <Panel title={L("Copas Guard (akses terdelegasi Dynamic)", "Copas Guard (Dynamic delegated access)")} aside={<Source kind="live">Dynamic delegated access</Source>}>
      <p className="text-sm text-ink-2">
        {L(
          "Beri server Copas satu izin: menghentikan copy (unfollow) vault kamu saat leader breach, drawdown-nya melewati 80% batas, atau mandatnya dilonggarkan tanpa persetujuanmu. Policy signer Dynamic hanya mengizinkan unfollow() pada vault kamu di Monad testnet. Dana tidak pernah bergerak; kamu bisa mencabut kapan saja.",
          "Give Copas' server one permission: stop copying (unfollow) your vault when your leader breaches, its drawdown passes 80% of its limit, or it loosens its mandate without your consent. The Dynamic signer policy allows only unfollow() on your vault, on Monad testnet. Funds never move; revoke any time.",
        )}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <span className={g?.delegated ? "text-up" : "text-ink-3"}>
          {g == null ? "…" : g.delegated ? L(`Aktif sejak ${g.since?.slice(0, 16).replace("T", " ")}`, `Active since ${g.since?.slice(0, 16).replace("T", " ")}`) : L("Tidak aktif", "Off")}
        </span>
        {g && !g.delegated && (
          <button
            className={btn.primary}
            disabled={!!busy}
            onClick={run("delegate", async () => {
              await (await import("@/lib/dynamic/client")).delegate([vault]);
              await waitFor(true);
            })}
          >
            {busy === "delegate" ? "…" : L("Aktifkan Guard", "Turn on Guard")}
          </button>
        )}
        {g?.delegated && (
          <>
            <button
              className={btn.ghost}
              disabled={!!busy}
              onClick={run("guard", async () => {
                const r = await fetch("/api/dynamic/guard", { method: "POST", body: JSON.stringify({ address }) }).then((x) => x.json());
                if (r.error) throw new Error(r.error);
                setActed(r.acted);
                if (!r.acted.length) setMsg(L("Semua aturan aman; tidak ada aksi.", "Every rule is fine; nothing to do."));
                else router.refresh();
                await load();
              })}
            >
              {busy === "guard" ? "…" : L("Jalankan Guard sekarang", "Run Guard now")}
            </button>
            <button
              className={btn.ghost}
              disabled={!!busy}
              onClick={run("revoke", async () => {
                await (await import("@/lib/dynamic/client")).revoke();
                await waitFor(false);
              })}
            >
              {busy === "revoke" ? "…" : L("Cabut", "Revoke")}
            </button>
          </>
        )}
      </div>
      {!!g?.checks.length && (
        <ul className="mt-3 grid gap-1 text-xs text-ink-3">
          {g.checks.map((c) => (
            <li key={c.vault} className="num">
              {short(c.vault)} → {short(c.leader)}: {c.status}, DD {c.ddPct.toFixed(2)}% / {c.maxDDPct}%, consent {c.consentOk === null ? "n/a" : c.consentOk ? "ok" : "lost"} ·{" "}
              <span className={c.reason ? "text-warn" : "text-up"}>{c.reason ?? L("aman", "safe")}</span>
            </li>
          ))}
        </ul>
      )}
      {acted.map((a) => (
        <p key={a.vault} className="mt-2 text-xs">
          {a.hash ? (
            <a className="text-gold-2 underline" href={explorerTx(a.hash, copasChain.id)} target="_blank" rel="noreferrer">
              unfollow {short(a.vault)}: {a.status} ({a.reason})
            </a>
          ) : (
            <span className="text-down">
              unfollow {short(a.vault)}: {a.error}
            </span>
          )}
        </p>
      ))}
      {msg && (
        <p role="status" className="mt-2 text-xs text-ink-2">
          {msg}
        </p>
      )}
    </Panel>
  );
}
