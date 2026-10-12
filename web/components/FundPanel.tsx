"use client";
import { useEffect, useState } from "react";
import { createPublicClient, createWalletClient, erc20Abi, formatUnits, http, parseUnits, type Hex } from "viem";
import { copasChain, explorerTx, monad } from "@/lib/chains";
import { useMeraSession } from "@/lib/mera/MeraProvider";
import { num, short, usd } from "@/lib/format";
import { btn } from "@/components/ui";

type Provider = "aurora" | "socket" | "kuru";
const NAME: Record<Provider, string> = { aurora: "Aurora 1Click (NEAR Intents)", socket: "Socket", kuru: "Kuru Flow" };
const MONAD_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";

// ids are the onramp's `chain:symbol` source ids; `via` is the order providers are tried in (first one that quotes wins).
const SOURCES: { id: string; label: string; symbol: string; dec: number; via: Provider[] }[] = [
  { id: "base:USDC", label: "USDC on Base", symbol: "USDC", dec: 6, via: ["aurora", "socket"] },
  { id: "arb:USDC", label: "USDC on Arbitrum", symbol: "USDC", dec: 6, via: ["aurora", "socket"] },
  { id: "eth:USDC", label: "USDC on Ethereum", symbol: "USDC", dec: 6, via: ["aurora", "socket"] },
  { id: "base:ETH", label: "ETH on Base", symbol: "ETH", dec: 18, via: ["aurora", "socket"] },
  { id: "arb:ETH", label: "ETH on Arbitrum", symbol: "ETH", dec: 18, via: ["aurora", "socket"] },
  { id: "eth:ETH", label: "ETH on Ethereum", symbol: "ETH", dec: 18, via: ["aurora", "socket"] },
  { id: "bsc:USDT", label: "USDT on BNB Chain", symbol: "USDT", dec: 18, via: ["aurora", "socket"] },
  { id: "sol:USDC", label: "USDC on Solana", symbol: "USDC", dec: 6, via: ["aurora"] },
  { id: "sol:SOL", label: "SOL on Solana", symbol: "SOL", dec: 9, via: ["aurora"] },
  { id: "monad:MON", label: "MON on Monad", symbol: "MON", dec: 18, via: ["kuru"] },
  { id: "monad:USDC", label: "USDC on Monad", symbol: "USDC", dec: 6, via: ["kuru"] },
];
// Quotes do not depend on the recipient, so signed-out visitors get real numbers against a placeholder address.
// Deposit addresses and txs are only ever shown for the signed-in wallet.
const QUOTE_ONLY_EVM = "0x1111111111111111111111111111111111111111"; // 1Click rejects 0x…dEaD as a recipient
const QUOTE_ONLY_SOL = "11111111111111111111111111111111";

type J = Record<string, unknown> & { error?: string; upstream?: { message?: string } };
async function call(path: string, body?: unknown): Promise<{ ok: boolean; j: J }> {
  try {
    const r = await fetch(`/api/onramp/${path}`, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
    return { ok: r.ok, j: await r.json().catch(() => ({ error: `HTTP ${r.status}` })) };
  } catch (e) {
    return { ok: false, j: { error: e instanceof Error ? e.message : String(e) } };
  }
}
const why = (j: J) => [j.error, j.upstream?.message].filter(Boolean).join(": ") || "unknown error";
const n = (v: unknown) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : null);
const amt = (atomic: unknown, dec: number) => (typeof atomic === "string" && /^\d+$/.test(atomic) ? Number(formatUnits(BigInt(atomic), dec)) : null);
const fmt = (v: number | null, sym: string) => (v == null ? "–" : `${num(v, v < 1 ? 4 : 2)} ${sym}`);

type Tx = { to: `0x${string}`; data: Hex; value: string; label: string };
type Deposit = { address: string; send: string; until: string | null; statusId: string };
type Quote = { provider: Provider; route: string; out: number | null; minOut: number | null; outSym: string; feeUsd: number | null; eta: string; deposit?: Deposit; txs?: Tx[]; mine: boolean };
type Status = { label: string; terminal: boolean; originTx: string[]; destTx: string[]; note?: string; usdcAtomic?: string };

const mainnet = createPublicClient({ chain: monad, transport: http() });

export function FundPanel() {
  const { status, address, authorize } = useMeraSession();
  const me = status === "signed-in" ? address : undefined;
  const [src, setSrc] = useState(SOURCES[0]!.id);
  const [amount, setAmount] = useState("10");
  const [solRefund, setSolRefund] = useState("");
  const [busy, setBusy] = useState(false);
  const [fails, setFails] = useState<{ provider: Provider; msg: string }[]>([]);
  const [q, setQ] = useState<Quote>();
  const [st, setSt] = useState<Status | { error: string }>();
  const [sent, setSent] = useState<{ hash: string; label: string }[]>([]);
  const [signErr, setSignErr] = useState<string>();
  const [bal, setBal] = useState<number | null>(null);

  const s = SOURCES.find((x) => x.id === src)!;
  const isSol = s.id.startsWith("sol:");
  let atomic: string | null = null;
  try {
    if (/^\d*\.?\d+$/.test(amount.trim())) atomic = parseUnits(amount.trim(), s.dec).toString();
  } catch {}
  if (atomic === "0") atomic = null;
  const recipient = me ?? QUOTE_ONLY_EVM;
  const refundTo = isSol ? solRefund.trim() || QUOTE_ONLY_SOL : recipient;
  const reset = () => (setQ(undefined), setFails([]), setSt(undefined), setSent([]), setSignErr(undefined));

  // Kuru swaps spend the wallet's own balance on Monad mainnet: show it so a failed swap is never a surprise.
  useEffect(() => {
    setBal(null);
    if (!me || !s.via.includes("kuru")) return;
    const p = s.symbol === "MON" ? mainnet.getBalance({ address: me }) : mainnet.readContract({ address: MONAD_USDC, abi: erc20Abi, functionName: "balanceOf", args: [me] });
    p.then((b) => setBal(Number(formatUnits(b, s.dec)))).catch(() => setBal(null));
  }, [me, s]);

  async function quote() {
    if (!atomic) return;
    reset();
    setBusy(true);
    const failed: { provider: Provider; msg: string }[] = [];
    for (const p of s.via) {
      const r = await tryQuote(p, atomic);
      if ("msg" in r) {
        failed.push({ provider: p, msg: r.msg });
        setFails([...failed]);
        continue;
      }
      setQ(r);
      break;
    }
    setBusy(false);
  }

  async function tryQuote(p: Provider, atomic: string): Promise<Quote | { msg: string }> {
    if (p === "aurora") {
      const { ok, j } = await call("aurora/quote", { source: s.id, amount: atomic, refundTo, recipient });
      if (!ok) return { msg: why(j) };
      const fee = n(j.amountInUsd) != null && n(j.amountOutUsd) != null ? n(j.amountInUsd)! - n(j.amountOutUsd)! : null;
      return { provider: p, route: `${s.label} → USDC on Monad (NEAR Intents solvers), then USDC → AUSD with Kuru Flow`, out: amt(j.amountOut, 6), minOut: amt(j.minAmountOut, 6), outSym: "USDC", feeUsd: fee, eta: `~${n(j.timeEstimate) ?? "?"} s`, mine: !!me };
    }
    if (p === "socket") {
      const { ok, j } = await call("socket/deposit-address", { source: s.id, amount: atomic, receiver: recipient });
      if (!ok) return { msg: why(j) };
      const tok = j.token as { symbol?: string; decimals?: number } | undefined;
      const fee = n(j.inputUsd) != null && n(j.outputUsd) != null ? n(j.inputUsd)! - n(j.outputUsd)! : null;
      return {
        provider: p,
        route: `${s.label} → AUSD on Monad via ${j.bridge ?? "Socket"}`,
        out: amt(j.output, 6),
        minOut: amt(j.minOutput, 6),
        outSym: "AUSD",
        feeUsd: fee,
        eta: `~${n(j.estimatedTimeSec) ?? "?"} s`,
        mine: !!me,
        deposit: me
          ? { address: String(j.depositAddress), send: fmt(amt(j.amount, tok?.decimals ?? s.dec), tok?.symbol ?? s.symbol), until: n(j.expiresAt) ? new Date(n(j.expiresAt)! * 1000).toLocaleString() : null, statusId: String(j.quoteId) }
          : undefined,
      };
    }
    const { ok, j } = await call("kuru/quote", { userAddress: recipient, tokenIn: s.symbol, amount: atomic });
    if (!ok) return { msg: why(j) };
    return { provider: p, route: `${s.label} → AUSD on Monad, one swap through Kuru Flow`, out: amt(j.output, 6), minOut: amt(j.minOut, 6), outSym: "AUSD", feeUsd: null, eta: "one Monad block", txs: me ? (j.txs as Tx[]) : undefined, mine: !!me };
  }

  async function auroraAddress() {
    if (!atomic || !q || !me) return;
    setBusy(true);
    const { ok, j } = await call("aurora/deposit-address", { source: s.id, amount: atomic, refundTo, recipient: me });
    setBusy(false);
    if (!ok) return setSt({ error: why(j) });
    setQ({ ...q, deposit: { address: String(j.depositAddress), send: `${j.amountInFormatted} ${s.symbol}`, until: j.deadline ? new Date(String(j.deadline)).toLocaleString() : null, statusId: String(j.depositAddress) } });
  }

  // Poll the provider every 10 s until the transfer is final (Aurora allows 2000 req/h per key).
  const dep = q?.deposit;
  const prov = q?.provider;
  useEffect(() => {
    if (!dep || !prov) return;
    let stop = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const { ok, j } = await call(`${prov}/status/${dep.statusId}`);
      if (stop) return;
      if (!ok) setSt({ error: why(j) });
      else {
        const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : v ? [String(v)] : []);
        setSt({
          label: String(j.phase ?? j.status ?? "unknown").replace(/_/g, " "),
          terminal: !!j.terminal,
          originTx: list(j.originTx),
          destTx: list(j.destinationTx),
          note: j.refundReason ? `Refund reason: ${j.refundReason}` : undefined,
          usdcAtomic: j.readyForDeposit && typeof j.receivedAtomic === "string" ? j.receivedAtomic : undefined,
        });
        if (j.terminal) return;
      }
      t = setTimeout(tick, 10_000);
    };
    t = setTimeout(tick, 0);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [dep, prov]);

  async function sign() {
    if (!q?.txs) return;
    setSignErr(undefined);
    setBusy(true);
    try {
      const account = await authorize("risky");
      const w = createWalletClient({ account, chain: monad, transport: http() });
      for (const tx of q.txs) {
        const hash = await w.sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value) });
        setSent((x) => [...x, { hash, label: tx.label }]);
        const rc = await mainnet.waitForTransactionReceipt({ hash });
        if (rc.status !== "success") throw new Error(`${tx.label} reverted`);
      }
    } catch (e) {
      setSignErr(e instanceof Error ? e.message.split("\n")[0] : String(e));
    } finally {
      setBusy(false);
    }
  }

  const amountNum = Number(amount);
  const short_ = bal != null && amountNum > bal;
  const input = "num mt-1 w-full rounded-md border border-line-strong bg-bg px-3 py-2 text-sm focus:border-gold focus:outline-none";

  return (
    <div className="space-y-4 text-sm">
      <p className="text-ink-2">
        Bring USDC, ETH, USDT or SOL from another chain, or swap MON on Monad. Quotes come live from the providers; nothing is estimated here.
        {copasChain.id === monad.id
          ? " AUSD lands in your Mera wallet on Monad, ready for the deposit above."
          : " Funds land on Monad mainnet at your Mera address. Copas vaults run on Monad testnet during the hackathon, so this AUSD does not reach a testnet vault."}
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="fund-src" className="text-ink-2">
            From
          </label>
          <select id="fund-src" className={input} value={src} onChange={(e) => (setSrc(e.target.value), reset())}>
            {SOURCES.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="fund-amt" className="text-ink-2">
            Amount ({s.symbol})
          </label>
          <input id="fund-amt" inputMode="decimal" className={input} value={amount} aria-invalid={!atomic} onChange={(e) => (setAmount(e.target.value), reset())} />
          {!atomic && <p className="mt-1 text-xs text-down">Enter an amount above 0.</p>}
          {bal != null && <p className={`mt-1 text-xs ${short_ ? "text-down" : "text-ink-3"}`}>Your balance on Monad: {fmt(bal, s.symbol)}</p>}
        </div>
        {isSol && (
          <div className="sm:col-span-2">
            <label htmlFor="fund-refund" className="text-ink-2">
              Solana refund address
            </label>
            <input id="fund-refund" className={input} value={solRefund} onChange={(e) => (setSolRefund(e.target.value), reset())} placeholder="Your Solana address, used only if the transfer is refunded" />
          </div>
        )}
      </div>
      <button className={btn.primary} disabled={!atomic || busy} onClick={quote}>
        {busy && !q ? "Asking providers…" : "Get quote"}
      </button>

      <div aria-live="polite" data-testid="fund-result" className="space-y-3">
        {fails.map((f) => (
          <p key={f.provider} role="alert" className="rounded-md border border-warn/40 p-3 text-warn">
            {NAME[f.provider]} could not quote this: {f.msg}
            {q ? `. Using ${NAME[q.provider]} instead.` : ""}
          </p>
        ))}
        {!busy && !q && fails.length === s.via.length && fails.length > 0 && <p className="text-ink-2">No provider can route this right now. Try another source or amount.</p>}
        {q && (
          <div className="rounded-md border border-line p-3">
            <dl className="space-y-1.5">
              {[
                ["Provider", NAME[q.provider]],
                ["Route", q.route],
                ["You receive", fmt(q.out, q.outSym)],
                ["Minimum after slippage", fmt(q.minOut, q.outSym)],
                ["Fees and slippage", q.feeUsd != null ? usd(Math.max(0, q.feeUsd), { dp: 2 }) : "Inside the rate; you pay Monad gas"],
                ["Time", q.eta],
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4">
                  <dt className="text-ink-3">{k}</dt>
                  <dd className="num text-right">{v}</dd>
                </div>
              ))}
            </dl>
            {!q.mine && <p className="mt-3 text-ink-3">Sign in with your passkey to get a deposit address or swap for your own wallet.</p>}
            {q.mine && q.provider === "aurora" && !q.deposit && (
              <button className={btn.ghost + " mt-3"} disabled={busy || (isSol && !solRefund.trim())} onClick={auroraAddress}>
                {busy ? "Requesting…" : "Get my deposit address"}
              </button>
            )}
            {q.deposit && (
              <div className="mt-3 space-y-1 border-t border-line pt-3">
                <p>
                  Send exactly <span className="num font-medium">{q.deposit.send}</span> ({s.label}) to
                </p>
                <p className="num select-all break-all font-medium text-ink">{q.deposit.address}</p>
                {q.deposit.until && <p className="text-xs text-ink-3">Valid until {q.deposit.until}. Funds go to {short(me ?? "")} on Monad; a failed route refunds on the source chain.</p>}
              </div>
            )}
            {q.txs && (
              <div className="mt-3 space-y-2 border-t border-line pt-3">
                <ol className="list-decimal space-y-0.5 pl-5 text-ink-2">
                  {q.txs.map((t, i) => (
                    <li key={i}>
                      {t.label} <span className="num text-ink-3">{short(t.to)}</span>
                    </li>
                  ))}
                </ol>
                <button className={btn.primary} disabled={busy || short_ || sent.length > 0} onClick={sign}>
                  {busy ? "Waiting for passkey…" : `Sign ${q.txs.length} transaction${q.txs.length > 1 ? "s" : ""} on Monad`}
                </button>
                {short_ && <p className="text-xs text-down">Your Mera wallet holds less {s.symbol} on Monad than this swap needs.</p>}
                {sent.map((x) => (
                  <p key={x.hash}>
                    {x.label}:{" "}
                    <a className="num underline" href={explorerTx(x.hash, monad.id)} target="_blank" rel="noreferrer">
                      {short(x.hash)}
                    </a>
                  </p>
                ))}
                {signErr && <p role="alert" className="text-down">{signErr}</p>}
              </div>
            )}
          </div>
        )}
        {st && "error" in st && <p role="alert" className="text-down">{st.error}</p>}
        {st && "label" in st && (
          <div className="rounded-md border border-line p-3">
            <p>
              Status: <span className="font-medium capitalize">{st.label}</span>
              {!st.terminal && <span className="text-ink-3"> · checking every 10 s</span>}
            </p>
            {st.originTx.map((h) => (
              <p key={h} className="num text-ink-3">
                Source tx {short(h)}
              </p>
            ))}
            {st.destTx.map((h) => (
              <p key={h}>
                Monad tx{" "}
                <a className="num underline" href={explorerTx(h, monad.id)} target="_blank" rel="noreferrer">
                  {short(h)}
                </a>
              </p>
            ))}
            {st.note && <p className="text-warn">{st.note}</p>}
            {st.usdcAtomic && (
              <button
                className={btn.ghost + " mt-2"}
                onClick={() => {
                  setSrc("monad:USDC");
                  setAmount(formatUnits(BigInt(st.usdcAtomic!), 6));
                  reset();
                }}
              >
                Swap the delivered USDC to AUSD
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
