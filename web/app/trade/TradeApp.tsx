"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BaseError, ContractFunctionRevertedError, erc20Abi, parseEventLogs, type Abi } from "viem";
import { Panel, Pill, Source, btn } from "@/components/ui";
import { useL } from "@/lib/i18n/client";
import { useMeraSession } from "@/lib/mera/MeraProvider";
import { copasPublic, useCopasWrite } from "@/lib/copas/useCopasWrite";
import { PERPL, copasChain, explorerAddr, explorerTx } from "@/lib/chains";
import { num, pct, price as fmtPrice, toAusd, usd } from "@/lib/format";
import {
  CANCEL, CLOSE_LONG, CLOSE_SHORT, DEFAULT_MANDATE, OPEN_LONG, OPEN_SHORT, REGISTRY_MARKETS,
  checkMandate, drawdown, fromLNS, fromPNS, liqPrice, looser, orderDesc, perplTradeAbi, toLNS, toPNS, toTMarkets, touch, walk,
  type Ledger, type Mandate, type TMarket,
} from "@/lib/perpl/trade";
import { perplExchangeAbi } from "@/lib/perpl/abi";
import { browserUrl, openOutsideTelegram, useInTelegram } from "@/components/AccountButton";
import { AusdFacts } from "./AusdFacts";

const net = PERPL[copasChain.id as keyof typeof PERPL];
const EX = net.exchange as `0x${string}`;
const AUSD = net.ausd as `0x${string}`;
const BUFFER = 0.005; // IOC limit 0.5% past the worst book level we expect to touch
const input = "num w-full rounded-md border border-line-strong bg-bg px-3 py-2.5 text-base focus:border-gold focus:outline-none";

async function api<T>(p: string): Promise<T> {
  const r = await fetch(`/api/perpl-testnet/${p}`);
  if (!r.ok) throw new Error(`perpl ${r.status}`);
  return r.json();
}

// ---------------------------------------------------------------- per-account local state (mandate rail)
type Rec = { h: string; sym: string; side: string; notional: number; lev: number; t: number };
type Local = { mandate: Mandate; ledger: Ledger | null; log: Rec[] };
const key = (a: string) => `copas.trade.v1.${a.toLowerCase()}`;
function loadLocal(a?: string): Local {
  const empty = { mandate: DEFAULT_MANDATE, ledger: null, log: [] };
  if (!a) return empty;
  try {
    return { ...empty, ...JSON.parse(localStorage.getItem(key(a)) || "{}") };
  } catch {
    return empty;
  }
}
function saveLocal(a: string, v: Local) {
  try {
    localStorage.setItem(key(a), JSON.stringify(v));
  } catch {
    /* private mode: the rail still works for this tab */
  }
}

/** getAccountByAddr reverts for an address without a Perpl account; that is "no account", not an RPC failure. */
const noAccount = (e: unknown) => {
  if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) return null;
  throw e;
};

type Pos = { m: TMarket; side: "long" | "short"; lot: bigint; size: number; entry: number; mark: number; margin: number; upnl: number; notional: number; liq: number | null };

async function readAccount(address: `0x${string}`, markets: TMarket[], perpId: number) {
  const [acct, wallet, allowance, mon] = await Promise.all([
    copasPublic.readContract({ address: EX, abi: perplTradeAbi, functionName: "getAccountByAddr", args: [address] }).catch(noAccount),
    copasPublic.readContract({ address: AUSD, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    copasPublic.readContract({ address: AUSD, abi: erc20Abi, functionName: "allowance", args: [address, EX] }),
    copasPublic.getBalance({ address }),
  ]);
  const id = acct && acct.accountId > 0n ? acct.accountId : 0n;
  const positions: Pos[] = [];
  let orders: { orderId: bigint; buy: boolean; size: number; price: number; locked: number }[] = [];
  if (id) {
    const res = await copasPublic.multicall({ contracts: markets.map((m) => ({ address: EX, abi: perplTradeAbi, functionName: "getPosition", args: [BigInt(m.id), id] }) as const) });
    res.forEach((r, i) => {
      if (r.status !== "success") return;
      const [p, markPNS] = r.result;
      if (p.lotLNS === 0n) return;
      const m = markets[i];
      const side = p.positionType === 0 ? "long" : "short";
      const size = fromLNS(p.lotLNS, m), mark = fromPNS(markPNS, m), margin = Number(p.depositCNS) / 1e6, upnl = Number(p.pnlCNS) / 1e6;
      positions.push({ m, side, lot: p.lotLNS, size, entry: fromPNS(p.pricePNS, m), mark, margin, upnl, notional: size * mark, liq: liqPrice(side, size, mark, margin + upnl, m.maintLev) });
    });
    const m = markets.find((x) => x.id === perpId)!;
    const [locks, info] = await Promise.all([
      copasPublic.readContract({ address: EX, abi: perplTradeAbi, functionName: "getPerpOrderLocks", args: [id, BigInt(perpId)] }),
      copasPublic.readContract({ address: EX, abi: perplExchangeAbi, functionName: "getPerpetualInfo", args: [BigInt(perpId)] }),
    ]);
    // orderLockId = perpId << 16 | orderId (verified by simulation); the order itself carries price and size
    const ids = locks.map((l) => BigInt(l.orderLockId & 0xffff));
    const ords = await copasPublic.multicall({ contracts: ids.map((o) => ({ address: EX, abi: perplTradeAbi, functionName: "getOrder", args: [BigInt(perpId), o] }) as const) });
    orders = ords.flatMap((r, i) =>
      r.status === "success" && BigInt(r.result.accountId) === id && r.result.lotLNS > 0n
        ? [{ orderId: ids[i], buy: r.result.orderType === OPEN_LONG || r.result.orderType === CLOSE_SHORT, size: fromLNS(r.result.lotLNS, m), price: fromPNS(BigInt(r.result.priceONS) + info.basePricePNS, m), locked: Number(locks[i].amountCNS) / 1e6 }]
        : [],
    );
  }
  const balance = acct ? Number(acct.balanceCNS) / 1e6 : 0;
  const locked = acct ? Number(acct.lockedBalanceCNS) / 1e6 : 0;
  return {
    id,
    wallet: Number(wallet) / 1e6,
    allowance,
    mon: Number(mon) / 1e18,
    balance,
    free: balance - locked,
    locked,
    positions,
    orders,
    equity: balance + positions.reduce((s, p) => s + p.margin + p.upnl, 0),
    gross: positions.reduce((s, p) => s + p.notional, 0),
  };
}

export function TradeApp({ initial }: { initial?: string }) {
  const L = useL();
  const qc = useQueryClient();
  const { status, address, signIn, create, authorize, supported, error: authErr } = useMeraSession();
  const { write, pending, error } = useCopasWrite();
  const signedIn = status === "signed-in" && !!address;
  const inTelegram = useInTelegram();

  const ctx = useQuery({ queryKey: ["pt-ctx"], queryFn: () => api<Parameters<typeof toTMarkets>[0]>("v1/pub/context").then(toTMarkets), staleTime: 300_000 });
  const markets = useMemo(() => ctx.data ?? [], [ctx.data]);
  const [mId, setMId] = useState<number>();
  const m = markets.find((x) => x.id === mId) ?? markets.find((x) => x.sym === (initial ?? "BTC").toUpperCase()) ?? markets[0];

  const tick = useQuery({ queryKey: ["pt-tick"], queryFn: () => api<{ d: Record<string, { mrk: number; prv: number; bid: number; ask: number; oi: number }> }>("v1/market-data/ticker"), refetchInterval: 5_000 });
  const book = useQuery({
    queryKey: ["pt-book", m?.id],
    enabled: !!m,
    refetchInterval: 3_000,
    queryFn: async () => {
      const b = await api<{ bid: { p: number; s: number }[]; ask: { p: number; s: number }[] }>(`v1/market-data/${m!.id}/book?levels=20`);
      const h = (l: { p: number; s: number }) => ({ p: fromPNS(l.p, m!), s: fromLNS(l.s, m!) });
      return { bid: b.bid.map(h), ask: b.ask.map(h) };
    },
  });
  const acct = useQuery({
    queryKey: ["pt-acct", address, m?.id, markets.length],
    enabled: !!address && !!m,
    refetchInterval: 6_000,
    queryFn: () => readAccount(address!, markets, m!.id),
  });
  const a = acct.data;
  const refresh = () => qc.invalidateQueries({ queryKey: ["pt-acct"] });

  // ---- local mandate + unit ledger (LeaderBook semantics, kept per passkey address on this device)
  const [local, setLocal] = useState<Local>(() => loadLocal());
  useEffect(() => setLocal(loadLocal(address)), [address]);
  const update = (f: (l: Local) => Local) =>
    setLocal((cur) => {
      const next = f(cur);
      if (address) saveLocal(address, next);
      return next;
    });
  useEffect(() => {
    if (a?.id && a.equity > 0) update((l) => ({ ...l, ledger: touch(l.ledger, a.equity) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a?.equity, a?.id]);
  const dd = a && local.ledger ? drawdown(local.ledger, a.equity) : 0;

  // ---- ticket
  const [side, setSide] = useState<"long" | "short">("long");
  const [type, setType] = useState<"market" | "limit">("market");
  const [size, setSize] = useState("");
  const [lev, setLev] = useState(3);
  const [limitPx, setLimitPx] = useState("");
  const [reduce, setReduce] = useState(false);
  const [msg, setMsg] = useState<{ tone: "up" | "warn"; text: string; h?: string }>();

  const t = m && tick.data?.d[String(m.id)];
  const mark = t ? fromPNS(t.mrk, m!) : NaN;
  const chg = t && t.prv ? ((t.mrk - t.prv) / t.prv) * 100 : NaN;
  const pos = a?.positions.find((p) => p.m.id === m?.id);
  const sizeN = Number(size);
  const lot = m && sizeN > 0 ? toLNS(sizeN, m) : 0n;
  const levels = side === "long" ? book.data?.ask : book.data?.bid;
  const est = type === "market" && levels && sizeN > 0 ? walk(levels, sizeN) : null;
  const px = type === "market" ? est?.avg ?? NaN : Number(limitPx);
  const notional = sizeN > 0 && px > 0 ? sizeN * px : 0;
  const margin = notional / lev;
  const fee = m ? (notional * m.takerBp) / 1e4 : 0;
  const closing = reduce && !!pos && pos.side !== side;
  const checks = m && a ? checkMandate(local.mandate, { sym: m.sym, lev, notional, reduce: closing, gross: a.gross, equity: a.equity, dd }) : [];
  const railOk = checks.every((c) => c.ok);
  const maxLev = m ? Math.min(m.maxLev, local.mandate.maxLev) : 1;
  useEffect(() => setLev((l) => Math.min(l, Math.max(1, Math.floor(maxLev)))), [maxLev]);

  const problem = !m
    ? L("Memuat pasar…", "Loading markets…")
    : lot === 0n
      ? L(`Ukuran minimal ${1 / 10 ** m.sd} ${m.sym}.`, `Minimum size ${1 / 10 ** m.sd} ${m.sym}.`)
      : type === "market" && !est
        ? L("Book terlalu tipis untuk ukuran ini.", "Book too thin for this size.")
        : type === "limit" && !(px > 0)
          ? L("Isi harga limit.", "Enter a limit price.")
          : reduce && !closing
            ? L("Reduce-only butuh posisi berlawanan di pasar ini.", "Reduce-only needs an opposite position in this market.")
            : closing && lot > pos!.lot
              ? L("Lebih besar dari posisi.", "Larger than the position.")
              : !closing && a && margin + fee > a.free
                ? L("Margin kurang. Deposit AUSD ke akun Perpl dulu.", "Not enough margin. Deposit AUSD to your Perpl account first.")
                : !railOk
                  ? L("Di luar mandat Anda.", "Outside your mandate.")
                  : undefined;

  async function send(o: { orderType: number; pricePNS: bigint; lotLNS: bigint; ioc: boolean; lev: number; orderId?: bigint }, rec?: Omit<Rec, "h" | "t">) {
    setMsg(undefined);
    const block = await copasPublic.getBlockNumber();
    const h = await write("small", {
      address: EX,
      abi: perplTradeAbi as Abi,
      functionName: "execOrder",
      args: [orderDesc({ perpId: m!.id, orderType: o.orderType, pricePNS: o.pricePNS, lotLNS: o.lotLNS, leverageHdths: BigInt(Math.round(o.lev * 100)), ioc: o.ioc, orderId: o.orderId }, block)],
    });
    if (!h) return;
    const r = await copasPublic.getTransactionReceipt({ hash: h });
    const logs = parseEventLogs({ abi: perplTradeAbi, logs: r.logs });
    const fills = logs.filter((l) => l.eventName === "TakerOrderFilledV2");
    const placed = logs.find((l) => l.eventName === "OrderPlaced");
    const filled = fills.reduce((s, l) => s + (l.eventName === "TakerOrderFilledV2" ? Number(l.args.lotLNS) : 0), 0);
    if (o.orderType === CANCEL) setMsg({ tone: "up", text: L("Order dibatalkan.", "Order cancelled."), h });
    else if (filled > 0) {
      const f = fills[0].eventName === "TakerOrderFilledV2" ? fills[0].args : undefined;
      setMsg({ tone: "up", text: L(`Terisi ${fromLNS(filled, m!)} ${m!.sym} @ ${fmtPrice(f ? fromPNS(f.entryPricePNS, m!) : NaN)}.`, `Filled ${fromLNS(filled, m!)} ${m!.sym} @ ${fmtPrice(f ? fromPNS(f.entryPricePNS, m!) : NaN)}.`), h });
    } else if (placed?.eventName === "OrderPlaced") setMsg({ tone: "up", text: L(`Order #${placed.args.orderId} di book.`, `Order #${placed.args.orderId} resting on the book.`), h });
    else setMsg({ tone: "warn", text: L("Tidak terisi: book bergerak melewati batas harga. Tidak ada yang berubah.", "Not filled: the book moved past the price limit. Nothing changed."), h });
    if (rec && (filled > 0 || placed)) update((l) => ({ ...l, log: [{ ...rec, h, t: Date.now() }, ...l.log].slice(0, 50) }));
    setSize("");
    refresh();
  }

  function submit() {
    if (!m || problem) return;
    const orderType = closing ? (pos!.side === "long" ? CLOSE_LONG : CLOSE_SHORT) : side === "long" ? OPEN_LONG : OPEN_SHORT;
    const limit = type === "market" ? est!.worst * (side === "long" ? 1 + BUFFER : 1 - BUFFER) : px;
    return send({ orderType, pricePNS: toPNS(limit, m), lotLNS: lot, ioc: type === "market", lev }, { sym: m.sym, side: closing ? "close" : side, notional, lev });
  }

  function closePos(p: Pos, frac = 1) {
    const lvls = p.side === "long" ? book.data?.bid : book.data?.ask;
    const l = (p.lot * BigInt(Math.round(frac * 100))) / 100n || p.lot;
    const w = lvls && walk(lvls, fromLNS(l, p.m));
    const ref = w?.worst ?? p.mark;
    return send({ orderType: p.side === "long" ? CLOSE_LONG : CLOSE_SHORT, pricePNS: toPNS(ref * (p.side === "long" ? 1 - BUFFER * 2 : 1 + BUFFER * 2), p.m), lotLNS: l, ioc: true, lev: 1 }, { sym: p.m.sym, side: "close", notional: fromLNS(l, p.m) * p.mark, lev: 1 });
  }

  // ---- funds
  const [amt, setAmt] = useState("100");
  const amtN = Number(amt);
  async function deposit() {
    if (!a || !(amtN > 0)) return;
    const raw = toAusd(amtN);
    setMsg(undefined);
    if (a.allowance < raw && !(await write("small", { address: AUSD, abi: erc20Abi as Abi, functionName: "approve", args: [EX, raw] }))) return;
    const h = await write("small", { address: EX, abi: perplTradeAbi as Abi, functionName: a.id ? "depositCollateral" : "createAccount", args: [raw] });
    if (h) {
      update((l) => ({ ...l, ledger: touch(a.id ? l.ledger : null, a.id ? a.equity : 0, amtN) }));
      setMsg({ tone: "up", text: a.id ? L(`${amtN} AUSD masuk akun Perpl.`, `${amtN} AUSD deposited to Perpl.`) : L("Akun Perpl dibuka.", "Perpl account opened."), h });
      refresh();
    }
  }
  async function withdraw() {
    if (!a?.id || !(amtN > 0)) return;
    setMsg(undefined);
    const h = await write("risky", { address: EX, abi: perplTradeAbi as Abi, functionName: "withdrawCollateral", args: [toAusd(amtN)] });
    if (h) {
      update((l) => ({ ...l, ledger: touch(l.ledger, a.equity, -amtN) }));
      setMsg({ tone: "up", text: L(`${amtN} AUSD kembali ke wallet.`, `${amtN} AUSD back in your wallet.`), h });
      refresh();
    }
  }
  const minOpen = 100, minDeposit = 10;
  const fundProblem = !a
    ? undefined
    : !(amtN > 0)
      ? L("Isi jumlah.", "Enter an amount.")
      : !a.id && amtN < minOpen
        ? L(`Deposit pertama minimal ${minOpen} AUSD (Perpl getMinAccountOpenCNS).`, `First deposit is at least ${minOpen} AUSD (Perpl getMinAccountOpenCNS).`)
        : a.id && amtN < minDeposit
          ? L(`Deposit minimal ${minDeposit} AUSD.`, `Minimum deposit ${minDeposit} AUSD.`)
          : amtN > a.wallet
            ? L("Melebihi saldo AUSD wallet.", "More than your wallet AUSD.")
            : undefined;

  // ---- mandate editor
  const [edit, setEdit] = useState<Mandate>();
  const [mErr, setMErr] = useState<string>();
  async function saveMandate() {
    if (!edit) return;
    setMErr(undefined);
    if (looser(local.mandate, edit)) {
      try {
        await authorize("risky"); // raising your own limits takes a fresh passkey, like a LeaderBook re-declare
      } catch {
        setMErr(L("Passkey dibatalkan; mandat tidak diubah.", "Passkey cancelled; mandate unchanged."));
        return;
      }
    }
    update((l) => ({ ...l, mandate: edit }));
    setEdit(undefined);
  }

  if (copasChain.id !== 10143) return <p className="text-sm text-ink-2">{L("Trading langsung hanya di testnet.", "Direct trading runs on testnet only.")}</p>;

  const sideBtn = (s: "long" | "short") =>
    `flex-1 rounded-md py-3 text-base font-semibold ${side === s ? (s === "long" ? "bg-up text-black" : "bg-down text-black") : "border border-line-strong text-ink-2"}`;

  return (
    <div className="space-y-4">
      <div className="space-y-3">
      {/* market strip */}
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" role="radiogroup" aria-label={L("Pasar", "Market")}>
        {markets.map((x) => (
          <button key={x.id} role="radio" aria-checked={x.id === m?.id} onClick={() => (setMId(x.id), setLimitPx(""))} className={`micro shrink-0 rounded-full px-3 py-2 ${x.id === m?.id ? "bg-ink text-bg" : "border border-line text-ink-2"}`}>
            {x.sym}
          </button>
        ))}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-xs text-ink-3">{m ? `${m.sym}-PERP · Perpl testnet · ${L("maks", "max")} ${m.maxLev}x` : "…"}</p>
          <p className="num text-3xl font-medium tracking-tight" aria-live="polite" data-testid="mark">{fmtPrice(mark)}</p>
        </div>
        <div className="text-right">
          <p className={`num text-sm ${chg >= 0 ? "text-up" : "text-down"}`}>{pct(chg, 2, true)}</p>
          <Source kind="live">{L("mark Perpl, 5 dtk", "Perpl mark, 5s")}</Source>
        </div>
      </div>

      </div>
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
      <div className="min-w-0 space-y-4 lg:order-1">
        {/* book */}
        <Panel title={L("Order book", "Order book")} aside={<span>{L("ketuk harga untuk limit", "tap a price for a limit")}</span>} pad={false}>
          <div className="grid grid-cols-2 gap-px bg-line text-xs">
            {(["bid", "ask"] as const).map((k) => (
              <ul key={k} className="bg-surface" aria-label={k === "bid" ? "Bids" : "Asks"}>
                {(book.data?.[k] ?? []).slice(0, 8).map((l, i) => (
                  <li key={i}>
                    <button onClick={() => (setType("limit"), setLimitPx(String(l.p)))} className="num flex w-full justify-between px-3 py-1.5 hover:bg-surface-2">
                      <span className={k === "bid" ? "text-up" : "text-down"}>{fmtPrice(l.p)}</span>
                      <span className="text-ink-2">{num(l.s, Math.min(m?.sd ?? 2, 4))}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
          </div>
          {book.isError && <p className="p-3 text-xs text-warn">{L("Book Perpl tidak terjangkau, mencoba lagi.", "Perpl book unreachable, retrying.")}</p>}
        </Panel>

        {/* position + orders */}
        {a && (a.positions.length > 0 || a.orders.length > 0) && (
          <Panel title={L("Posisi", "Positions")} aside={<Source kind="rpc">getPosition</Source>}>
            <div className="space-y-3">
              {a.positions.map((p) => (
                <div key={p.m.id} className="rounded-md border border-line p-3" data-testid={`pos-${p.m.sym}`}>
                  <div className="flex items-center justify-between">
                    <p className="font-medium">
                      <span className={p.side === "long" ? "text-up" : "text-down"}>{p.side === "long" ? "LONG" : "SHORT"}</span> {num(p.size, Math.min(p.m.sd, 5))} {p.m.sym}
                    </p>
                    <p className={`num ${p.upnl >= 0 ? "text-up" : "text-down"}`}>{usd(p.upnl, { sign: true })}</p>
                  </div>
                  <dl className="num mt-2 grid grid-cols-3 gap-2 text-xs">
                    <div><dt className="text-ink-3">{L("Masuk", "Entry")}</dt><dd>{fmtPrice(p.entry)}</dd></div>
                    <div><dt className="text-ink-3">Mark</dt><dd>{fmtPrice(p.mark)}</dd></div>
                    <div><dt className="text-ink-3">{L("Likuidasi", "Liq.")}</dt><dd className="text-warn">{fmtPrice(p.liq)}</dd></div>
                    <div><dt className="text-ink-3">Margin</dt><dd>{usd(p.margin)}</dd></div>
                    <div><dt className="text-ink-3">Notional</dt><dd>{usd(p.notional)}</dd></div>
                    <div><dt className="text-ink-3">Lev.</dt><dd>{num(p.notional / Math.max(p.margin + p.upnl, 1e-9), 2)}x</dd></div>
                  </dl>
                  <div className="mt-3 flex gap-2">
                    <button className={btn.ghost + " flex-1"} disabled={pending || !signedIn} onClick={() => closePos(p, 0.5)}>{L("Tutup 50%", "Close 50%")}</button>
                    <button className={btn.primary + " flex-1"} disabled={pending || !signedIn} onClick={() => closePos(p)}>{L("Tutup posisi", "Close position")}</button>
                  </div>
                </div>
              ))}
              {a.orders.map((o) => (
                <div key={String(o.orderId)} className="flex items-center justify-between gap-2 rounded-md border border-line p-3 text-sm" data-testid={`order-${o.orderId}`}>
                  <span className="num">
                    #{String(o.orderId)} {o.buy ? "BUY" : "SELL"} {num(o.size, Math.min(m?.sd ?? 2, 5))} {m?.sym} @ {fmtPrice(o.price)} · {usd(o.locked)} {L("terkunci", "locked")}
                  </span>
                  <button className={btn.ghost} disabled={pending || !signedIn} onClick={() => send({ orderType: CANCEL, pricePNS: 0n, lotLNS: 0n, ioc: false, lev: 0, orderId: o.orderId })}>
                    {L("Batal", "Cancel")}
                  </button>
                </div>
              ))}
            </div>
          </Panel>
        )}

        <MandateCard
          L={L}
          local={local}
          dd={dd}
          equity={a?.equity}
          edit={edit}
          setEdit={setEdit}
          save={saveMandate}
          err={mErr}
          signedIn={signedIn}
        />
        <AusdFacts />
      </div>

      {/* ticket + funds (first on mobile) */}
      <div className="order-first space-y-4 lg:order-2">
        {!signedIn ? (
          <Panel title={L("Trade dengan passkey", "Trade with your passkey")}>
            <p className="text-sm text-ink-2">
              {L(
                "Akun Mera: passkey adalah kunci Anda. Tanpa seed phrase, tanpa ekstensi. Order dikirim langsung ke Perpl dari akun Anda.",
                "A Mera account: your passkey is the key. No seed phrase, no extension. Orders go straight to Perpl from your own account.",
              )}
            </p>
            {inTelegram && (
              <div className="mt-3 rounded-md border border-warn/40 p-3" data-testid="tg-passkey">
                <p className="text-xs text-warn">
                  {L(
                    "Anda di dalam Telegram. Webview Telegram di kebanyakan aplikasi tidak bisa memakai passkey. Buka /trade di browser untuk tanda tangan; harga, book, dan data AUSD tetap jalan di sini.",
                    "You're inside Telegram. Its webview can't use passkeys on most clients. Open /trade in your browser to sign; prices, book and AUSD data keep working here.",
                  )}
                </p>
                <button className={btn.primary + " mt-2 w-full py-3"} onClick={() => openOutsideTelegram(browserUrl())}>
                  {L("Buka di browser", "Open in browser")}
                </button>
              </div>
            )}
            {supported === false && !inTelegram && (
              <p className="mt-3 text-xs text-warn">{L("Browser ini tidak mendukung passkey (WebAuthn). Buka di Chrome atau Safari terbaru.", "This browser has no passkey (WebAuthn) support. Open it in a current Chrome or Safari.")}</p>
            )}
            <div className="mt-3 flex flex-col gap-2">
              <button className={btn.primary + " py-3"} onClick={() => signIn().catch(() => undefined)} disabled={status === "working" || supported === false}>
                {inTelegram ? L("Coba passkey di sini", "Try passkey here") : "Sign in with passkey"}
              </button>
              <button className={btn.ghost + " py-3"} onClick={() => create().catch(() => undefined)} disabled={status === "working" || supported === false}>
                Create passkey account
              </button>
            </div>
            {authErr && (
              <p role="alert" className="mt-2 text-xs text-down">
                {L(authErr.message.id, authErr.message.en)}
                {inTelegram && ` ${L("Di Telegram: pakai Buka di browser di atas.", "In Telegram: use Open in browser above.")}`}
              </p>
            )}
          </Panel>
        ) : (
          <Panel title={L("Dana", "Funds")} aside={<Source kind="rpc">AUSD · Perpl</Source>}>
            <dl className="num grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs text-ink-3">{L("Wallet AUSD", "Wallet AUSD")}</dt><dd data-testid="wallet-ausd">{a ? num(a.wallet, 2) : "…"}</dd></div>
              <div><dt className="text-xs text-ink-3">{L("Akun Perpl", "Perpl account")}</dt><dd data-testid="perpl-balance">{a ? (a.id ? num(a.balance, 2) : L("belum dibuka", "not opened")) : "…"}</dd></div>
              <div><dt className="text-xs text-ink-3">{L("Bebas untuk margin", "Free margin")}</dt><dd>{a?.id ? usd(a.free) : "–"}</dd></div>
              <div><dt className="text-xs text-ink-3">Equity</dt><dd>{a?.id ? usd(a.equity) : "–"}</dd></div>
            </dl>
            {a && a.mon < 0.2 && <p className="mt-2 text-xs text-warn">{L("MON untuk gas hampir habis: pakai “Get testnet MON + AUSD” di menu akun.", "Low MON for gas: use “Get testnet MON + AUSD” in the account menu.")}</p>}
            {a && !a.id && a.wallet < minOpen && <p className="mt-2 text-xs text-warn">{L("Butuh ≥100 AUSD: pakai “Get testnet MON + AUSD” di menu akun.", "You need ≥100 AUSD: use “Get testnet MON + AUSD” in the account menu.")}</p>}
            <label htmlFor="t-amt" className="mt-3 block text-xs text-ink-3">{L("Jumlah AUSD", "AUSD amount")}</label>
            <input id="t-amt" type="number" inputMode="decimal" min={0} step="any" className={input} value={amt} onChange={(e) => setAmt(e.target.value)} />
            <div className="mt-2 flex gap-2">
              <button className={btn.primary + " flex-1 py-2.5"} disabled={pending || !a || !!fundProblem} onClick={deposit}>
                {a && !a.id ? L("Buka akun Perpl", "Open Perpl account") : L("Deposit ke Perpl", "Deposit to Perpl")}
              </button>
              {a?.id ? (
                <button className={btn.ghost + " flex-1 py-2.5"} disabled={pending || !(amtN > 0) || amtN > a.free} onClick={withdraw}>
                  {L("Tarik", "Withdraw")}
                </button>
              ) : null}
            </div>
            {fundProblem && <p className="mt-1 text-xs text-ink-3">{fundProblem}</p>}
            {a?.id ? (
              <p className="mt-2 text-xs text-ink-3">
                {L("Akun Perpl", "Perpl account")} #{String(a.id)} ·{" "}
                <a className="underline" href={explorerAddr(address!, copasChain.id)} target="_blank" rel="noreferrer">{L("lihat di explorer", "view on explorer")}</a>
              </p>
            ) : null}
          </Panel>
        )}

        <Panel title={L("Tiket order", "Order ticket")}>
          <div className="flex gap-2" role="radiogroup" aria-label={L("Arah", "Side")}>
            <button role="radio" aria-checked={side === "long"} className={sideBtn("long")} onClick={() => setSide("long")}>Long</button>
            <button role="radio" aria-checked={side === "short"} className={sideBtn("short")} onClick={() => setSide("short")}>Short</button>
          </div>
          <div className="mt-3 flex gap-1 rounded-md bg-surface-2 p-1" role="radiogroup" aria-label={L("Tipe order", "Order type")}>
            {(["market", "limit"] as const).map((k) => (
              <button key={k} role="radio" aria-checked={type === k} onClick={() => setType(k)} className={`flex-1 rounded py-2 text-sm ${type === k ? "bg-bg text-ink" : "text-ink-3"}`}>
                {k === "market" ? L("Market (IOC)", "Market (IOC)") : L("Limit (di book)", "Limit (rests)")}
              </button>
            ))}
          </div>
          <label htmlFor="t-size" className="mt-3 block text-xs text-ink-3">{L("Ukuran", "Size")} ({m?.sym})</label>
          <input id="t-size" type="number" inputMode="decimal" min={0} step="any" placeholder={m ? String(1 / 10 ** m.sd) : ""} className={input} value={size} onChange={(e) => setSize(e.target.value)} />
          {a?.id && m && mark > 0 ? (
            <div className="mt-2 flex gap-1.5">
              {[0.1, 0.25, 0.5].map((f) => (
                <button key={f} className="micro flex-1 rounded border border-line py-1.5 text-ink-2" onClick={() => setSize(String(Math.floor(((a.free * f * lev) / mark) * 10 ** m.sd) / 10 ** m.sd))}>
                  {f * 100}%
                </button>
              ))}
              {pos && (
                <button className="micro flex-1 rounded border border-line py-1.5 text-ink-2" onClick={() => (setSize(String(pos.size)), setSide(pos.side === "long" ? "short" : "long"), setReduce(true))}>
                  {L("Posisi", "Position")}
                </button>
              )}
            </div>
          ) : null}
          {type === "limit" && (
            <>
              <label htmlFor="t-px" className="mt-3 block text-xs text-ink-3">{L("Harga limit", "Limit price")}</label>
              <input id="t-px" type="number" inputMode="decimal" min={0} step="any" className={input} value={limitPx} onChange={(e) => setLimitPx(e.target.value)} />
            </>
          )}
          {!closing && (
            <>
              <label htmlFor="t-lev" className="mt-3 flex justify-between text-xs text-ink-3">
                <span>{L("Leverage", "Leverage")}</span>
                <span className="num text-ink">{lev}x</span>
              </label>
              <input id="t-lev" type="range" min={1} max={Math.max(1, Math.floor(maxLev))} value={lev} onChange={(e) => setLev(Number(e.target.value))} className="w-full accent-[var(--gold)]" />
              <p className="text-xs text-ink-3">{L(`Batas: mandat ${local.mandate.maxLev}x, Perpl ${m?.maxLev ?? "–"}x`, `Cap: your mandate ${local.mandate.maxLev}x, Perpl ${m?.maxLev ?? "–"}x`)}</p>
            </>
          )}
          <label className="mt-3 flex items-center gap-2 text-sm text-ink-2">
            <input type="checkbox" checked={reduce} onChange={(e) => setReduce(e.target.checked)} className="h-4 w-4" />
            {L("Reduce-only (tutup saja)", "Reduce-only (close only)")}
          </label>

          {notional > 0 && (
            <dl className="num mt-3 grid grid-cols-3 gap-2 rounded-md bg-surface-2 p-2 text-xs">
              <div><dt className="text-ink-3">{type === "market" ? L("Rata-rata", "Avg fill") : L("Harga", "Price")}</dt><dd>{fmtPrice(px)}</dd></div>
              <div><dt className="text-ink-3">Notional</dt><dd>{usd(notional)}</dd></div>
              <div><dt className="text-ink-3">{closing ? L("Fee", "Fee") : "Margin"}</dt><dd>{closing ? usd(fee) : usd(margin + fee)}</dd></div>
            </dl>
          )}

          {/* the rail */}
          {signedIn && checks.length > 0 && notional > 0 && (
            <ul className="mt-3 space-y-1 text-xs" aria-label={L("Cek mandat", "Mandate check")} data-testid="rail">
              {checks.map((c) => (
                <li key={c.rule} className={`flex justify-between gap-2 ${c.ok ? "text-ink-2" : "text-down"}`}>
                  <span>{c.ok ? "✓" : "✕"} {c.rule}</span>
                  <span className="num">{c.detail}</span>
                </li>
              ))}
              {!railOk && <li className="text-down">{L("Leader berbond akan di-breach untuk order ini. Ubah order atau mandat Anda.", "A bonded leader would be breached by this order. Change the order or your mandate.")}</li>}
            </ul>
          )}

          <button
            className={`mt-3 w-full rounded-md py-3.5 text-base font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${closing ? "bg-ink text-bg" : side === "long" ? "bg-up text-black" : "bg-down text-black"}`}
            disabled={!signedIn || !a?.id || pending || !!problem}
            onClick={submit}
          >
            {pending
              ? L("Mengirim…", "Sending…")
              : closing
                ? L(`Tutup ${size || 0} ${m?.sym ?? ""}`, `Close ${size || 0} ${m?.sym ?? ""}`)
                : `${side === "long" ? "Long" : "Short"} ${size || 0} ${m?.sym ?? ""} · ${lev}x`}
          </button>
          {signedIn && a && !a.id && <p className="mt-1 text-xs text-ink-3">{L("Buka akun Perpl di panel Dana dulu.", "Open your Perpl account in Funds first.")}</p>}
          {signedIn && a?.id && problem && size !== "" && <p className="mt-1 text-xs text-ink-3">{problem}</p>}
          {msg && (
            <p role="status" className={`mt-2 text-sm ${msg.tone === "up" ? "text-up" : "text-warn"}`} data-testid="trade-status">
              {msg.text}{" "}
              {msg.h && (
                <a className="num underline" href={explorerTx(msg.h, copasChain.id)} target="_blank" rel="noreferrer">
                  {msg.h.slice(0, 10)}…
                </a>
              )}
            </p>
          )}
          {error && <p role="alert" className="mt-2 text-sm text-down">{error}</p>}
          <p className="mt-3 text-xs text-ink-3">
            {L("Setiap order adalah tx onchain ke Perpl", "Every order is an onchain tx to Perpl")} <span className="num">execOrder</span> ({short(EX)}), {L("ditandatangani passkey Anda.", "signed by your passkey.")}
          </p>
        </Panel>
      </div>
    </div>
    </div>
  );
}

const short = (x: string) => `${x.slice(0, 6)}…${x.slice(-4)}`;

function MandateCard({ L, local, dd, equity, edit, setEdit, save, err, signedIn }: {
  L: (id: string, en: string) => string;
  local: Local;
  dd: number;
  equity?: number;
  edit?: Mandate;
  setEdit: (m?: Mandate) => void;
  save: () => void;
  err?: string;
  signedIn: boolean;
}) {
  const md = local.mandate;
  const opened = local.log.filter((r) => r.side !== "close").length;
  const leaderHref = `/become-leader?dd=${md.maxDD}&lev=${md.maxLev}&markets=${md.markets.filter((x) => (REGISTRY_MARKETS as readonly string[]).includes(x)).join(",")}${equity ? `&capital=${Math.max(100, Math.floor(equity))}` : ""}`;
  return (
    <Panel title={L("Trade seperti leader berbond", "Trade like a bonded leader")} aside={<Pill tone={dd > md.maxDD ? "down" : "gold"}>{dd > md.maxDD ? L("breach", "breached") : L("dalam mandat", "in mandate")}</Pill>}>
      <p className="text-sm text-ink-2">
        {L(
          "Mandat yang sama dengan LeaderBook Copas: pasar, leverage, notional, drawdown dari puncak harga unit. Order di luar mandat diblok sebelum dikirim. Melonggarkan mandat butuh passkey baru.",
          "The same mandate a Copas LeaderBook enforces onchain: markets, leverage, notional, drawdown from the unit-price peak. Orders outside it are blocked before they are sent. Loosening it takes a fresh passkey.",
        )}
      </p>
      {!edit ? (
        <>
          <dl className="num mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div><dt className="text-xs text-ink-3">{L("Maks drawdown", "Max drawdown")}</dt><dd>{md.maxDD}% <span className="text-ink-3">({L("kini", "now")} {pct(dd)})</span></dd></div>
            <div><dt className="text-xs text-ink-3">{L("Maks leverage", "Max leverage")}</dt><dd>{md.maxLev}x</dd></div>
            <div><dt className="text-xs text-ink-3">{L("Maks notional", "Max notional")}</dt><dd>{md.maxNotional} AUSD</dd></div>
            <div><dt className="text-xs text-ink-3">{L("Pasar", "Markets")}</dt><dd>{md.markets.join(" ")}</dd></div>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={btn.ghost} onClick={() => setEdit({ ...md })}>{L("Ubah mandat", "Edit mandate")}</button>
            <Link className={btn.primary} href={leaderHref}>{L("Jadi leader dengan mandat ini", "Become a leader with this mandate")}</Link>
          </div>
          <p className="mt-2 text-xs text-ink-3">
            {L(`Rekam jejak di perangkat ini: ${opened} order buka, semuanya lolos cek mandat.`, `Record on this device: ${opened} opening orders, every one passed the mandate check.`)}{" "}
            {L("Leader berbond memasang AUSD sebagai jaminan untuk mandat ini; follower dibayar dari bond kalau dilanggar.", "A bonded leader posts AUSD behind this mandate; followers are paid from the bond if it is broken.")}
          </p>
        </>
      ) : (
        <div className="mt-3 space-y-3 text-sm">
          <div className="grid grid-cols-3 gap-2">
            {([["maxDD", L("Maks DD %", "Max DD %")], ["maxLev", L("Maks lev x", "Max lev x")], ["maxNotional", "Max notional"]] as const).map(([k, label]) => (
              <label key={k} className="text-xs text-ink-3">
                {label}
                <input type="number" inputMode="decimal" min={0} step="any" className={input + " mt-1"} value={edit[k]} onChange={(e) => setEdit({ ...edit, [k]: Number(e.target.value) })} />
              </label>
            ))}
          </div>
          <fieldset className="flex flex-wrap gap-2">
            <legend className="mb-1 text-xs text-ink-3">{L("Pasar (registry Copas)", "Markets (Copas registry)")}</legend>
            {REGISTRY_MARKETS.map((x) => (
              <label key={x} className="flex items-center gap-1.5 rounded border border-line px-2 py-1.5">
                <input type="checkbox" checked={edit.markets.includes(x)} onChange={(e) => setEdit({ ...edit, markets: e.target.checked ? [...edit.markets, x] : edit.markets.filter((y) => y !== x) })} />
                {x}
              </label>
            ))}
          </fieldset>
          <div className="flex gap-2">
            <button className={btn.primary} disabled={!signedIn || !(edit.maxDD > 0 && edit.maxDD <= 90 && edit.maxLev >= 1 && edit.maxLev <= 50 && edit.maxNotional > 0)} onClick={save}>
              {looser(md, edit) ? L("Simpan (passkey)", "Save (passkey)") : L("Simpan", "Save")}
            </button>
            <button className={btn.ghost} onClick={() => setEdit(undefined)}>{L("Batal", "Cancel")}</button>
          </div>
          {err && <p role="alert" className="text-xs text-down">{err}</p>}
        </div>
      )}
    </Panel>
  );
}
