import { Suspense } from "react";
import { Empty, Panel, Pill, Source } from "@/components/ui";
import { ago, price } from "@/lib/format";

/**
 * Perpl mark vs oracles Perpl does not use (Pyth, Chainlink Data Feeds, Supra), read onchain by @copas/services
 * (`/oracle/check`, `/leader/:book/oracle`). With `book`, it also checks the block of each breach of that leader.
 */
const BASE = process.env.COPAS_SERVICES_URL || "https://copas-services.vercel.app";
type Lx = (a: string, b: string) => string;
type Status = "ok" | "watch" | "spike" | "no_fresh_oracle";
type Src = { provider: string; feed: string; price: number; confidence: number | null; ageSec: number; fresh: boolean; deviationBps: number; independent: boolean };
type Market = { perpId: number; symbol: string; mark: number; perplOracle: { price: number; deviationBps: number }; sources: Src[]; reference: number | null; deviationBps: number | null; status: Status };
type Check = { chainId: number; block: number; blockTime: number; markets: Market[]; status: Status; summary: string; thresholds: { watchBps: number; spikeBps: number; maxAgeSec: number } };
type Ctx = { events: { kind: "breach" | "latest_checkpoint"; epoch: number; reason?: string; block: number; timestamp: number; txHash?: string; oracle: Check }[] };

async function get<T>(path: string, revalidate: number): Promise<T | null> {
  try {
    const r = await fetch(`${BASE}${path}`, { next: { revalidate }, signal: AbortSignal.timeout(20_000) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

const TONE = { ok: "up", watch: "warn", spike: "down", no_fresh_oracle: "neutral" } as const;
const bps = (x: number | null) => (x == null ? "—" : `${x > 0 ? "+" : ""}${x.toFixed(1)} bps`);
const NAME: Record<string, string> = { pyth: "Pyth", chainlink: "Chainlink", supra: "Supra" };
const age = (s: number) => ago(Date.now() - s * 1000);

function StatusPill({ s, L }: { s: Status; L: Lx }) {
  const label = { ok: "OK", watch: L("Waspada", "Watch"), spike: L("Lonjakan", "Spike"), no_fresh_oracle: L("Tanpa oracle segar", "No fresh oracle") }[s];
  return <Pill tone={TONE[s]}>{label}</Pill>;
}

async function Body({ chain, book, L }: { chain: number; book?: string; L: Lx }) {
  const [c, ctx] = await Promise.all([get<Check>(`/oracle/check?chain=${chain}`, 30), book ? get<Ctx>(`/leader/${book}/oracle`, 300) : null]);
  if (!c) return <Empty>{L("Layanan oracle tidak merespons. Coba lagi sebentar.", "The oracle service did not respond. Try again shortly.")}</Empty>;
  const breaches = ctx?.events.filter((e) => e.kind === "breach") ?? [];
  return (
    <div>
      {breaches.map((e) => (
        <div key={e.block} className="flex flex-wrap items-start gap-2 border-b border-line px-4 py-3 text-sm">
          <StatusPill s={e.oracle.status} L={L} />
          <p className="min-w-0 flex-1 text-ink-2">
            {L(`Breach epoch ${e.epoch} (${e.reason}): `, `Epoch ${e.epoch} breach (${e.reason}): `)}
            {e.oracle.status === "spike"
              ? L("terjadi saat harga Perpl menyimpang dari oracle independen. Kemungkinan dipicu dislokasi harga di Perpl saja, bukan pergerakan pasar.", "it happened while Perpl's price diverged from independent oracles. It may come from a Perpl-only price dislocation, not a market-wide move.")
              : L("harga Perpl sejalan dengan oracle independen saat itu. Pergerakan harganya nyata di seluruh pasar, bukan manipulasi mark Perpl.", "Perpl's price agreed with independent oracles at that block. The move was market-wide, not a manipulated Perpl mark.")}
            <span className="block text-xs text-ink-3">{e.oracle.summary}</span>
          </p>
        </div>
      ))}
      <div className="overflow-x-auto" tabIndex={0}>
        <table className="data">
          <thead>
            <tr>
              <th>Market</th>
              <th className="r">{L("Mark Perpl", "Perpl mark")}</th>
              <th className="r">{L("Referensi", "Reference")}</th>
              <th className="r">{L("Deviasi", "Deviation")}</th>
              <th>{L("Sumber (deviasi, umur)", "Sources (deviation, age)")}</th>
              <th className="r">{L("vs oracle Perpl", "vs Perpl oracle")}</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {c.markets.map((m) => (
              <tr key={m.perpId}>
                <td>{m.symbol}</td>
                <td className="r">{price(m.mark)}</td>
                <td className="r">{m.reference == null ? "—" : price(m.reference)}</td>
                <td className={`r ${m.status === "spike" ? "text-down" : m.status === "watch" ? "text-warn" : ""}`}>{bps(m.deviationBps)}</td>
                <td className="text-xs">
                  {m.sources.length
                    ? m.sources.map((s) => (
                        <span key={s.provider} className={`mr-3 whitespace-nowrap ${s.fresh ? "text-ink-2" : "text-ink-3 line-through"}`} title={`${s.feed}${s.confidence != null ? ` ±${price(s.confidence)}` : ""}${s.fresh ? "" : " (stale)"}`}>
                          {NAME[s.provider] ?? s.provider} {bps(s.deviationBps)}, {age(s.ageSec)}
                        </span>
                      ))
                    : L("tidak ada feed onchain", "no onchain feed")}
                </td>
                <td className="r text-ink-3">{bps(m.perplOracle.deviationBps)}</td>
                <td>
                  <StatusPill s={m.status} L={L} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-line px-4 py-3 text-xs text-ink-3">
        {L(
          `Blok ${c.block.toLocaleString("en-US")}. Referensi = median oracle segar (≤ ${c.thresholds.maxAgeSec / 60} menit); dicoret = basi. Waspada ≥ ${c.thresholds.watchBps} bps, lonjakan ≥ ${c.thresholds.spikeBps} bps. Oracle Perpl sendiri adalah Chainlink Data Streams.`,
          `Block ${c.block.toLocaleString("en-US")}. Reference = median of fresh oracles (≤ ${c.thresholds.maxAgeSec / 60} min); struck through = stale. Watch ≥ ${c.thresholds.watchBps} bps, spike ≥ ${c.thresholds.spikeBps} bps. Perpl's own oracle is Chainlink Data Streams.`,
        )}
      </p>
    </div>
  );
}

export function OracleCheckPanel({ chain, book, L, className }: { chain: number; book?: string; L: Lx; className?: string }) {
  return (
    <Panel className={className} title={L("Cek oracle: mark Perpl vs Pyth / Chainlink / Supra", "Oracle check: Perpl mark vs Pyth / Chainlink / Supra")} pad={false} aside={<Source kind="rpc">{L("Dibaca onchain", "Read onchain")}</Source>}>
      <Suspense fallback={<Empty>{L("Membaca oracle onchain…", "Reading oracles onchain…")}</Empty>}>
        <Body chain={chain} book={book} L={L} />
      </Suspense>
    </Panel>
  );
}
