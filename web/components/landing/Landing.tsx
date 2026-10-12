import Link from "next/link";
import { Hero3D } from "./Hero3D";

type Stats = { leaders: number | null; bonded: number; bond: number | null; breached: number; followerAum: number };
/** Lifetime indexer counters (lib/copas/indexer protocolMetrics); null when the indexer is down. */
type Metrics = { followers: number; syncs: number; slashPaid: number; claims: number; vaults: number; upkeep: number } | null;
type Lx = (id: string, en: string) => string;

const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

/** Editorial landing above the leaderboard. Every number shown comes from the live registry (props). */
export function Landing({ stats, metrics, L }: { stats: Stats; metrics: Metrics; L: Lx }) {
  const steps = [
    {
      n: "01",
      t: L("Leader menaruh jaminan", "Leaders post a bond"),
      d: L(
        "Jaminan AUSD dan mandat onchain: drawdown maksimum, leverage, ukuran, pasar. Tanpa jaminan, tidak ada follower.",
        "An AUSD bond and an onchain mandate: max drawdown, leverage, size, markets. No bond, no followers.",
      ),
      k: `${fmt(stats.bonded)} AUSD`,
      kl: L("dijaminkan sekarang", "bonded right now"),
    },
    {
      n: "02",
      t: L("Follower menyalin dari vault sendiri", "Followers copy from their own vault"),
      d: L(
        "Satu passkey, tanpa seed phrase. Vault milikmu hanya bisa bergerak ke rasio × posisi leader, di dalam batasmu.",
        "One passkey, no seed phrase. Your vault can only move toward ratio × the leader's position, inside your limits.",
      ),
      k: `${fmt(stats.followerAum)} AUSD`,
      kl: L("cap copy yang didaftarkan follower", "copy caps committed by followers"),
    },
    {
      n: "03",
      t: L("Langgar mandat, jaminan dipotong", "Break the mandate, lose the bond"),
      d: L(
        "Ekuitas dibaca langsung dari state Perpl, tanpa oracle. Pelanggaran memotong jaminan ke follower secara otomatis.",
        "Equity is read straight from Perpl state, no oracle. A breach slashes the bond to followers automatically.",
      ),
      k: String(stats.breached),
      kl: L("leader pernah dipotong", stats.breached === 1 ? "leader slashed so far" : "leaders slashed so far"),
    },
  ];

  return (
    <div className="-mx-4 -mt-5 mb-10 space-y-3 sm:-mx-6">
      {/* hero: paper screen in a black bezel */}
      <section className="relative mx-2 overflow-hidden rounded-[22px] border-[6px] border-black bg-paper text-[#121212] sm:mx-3" style={{ height: "min(78vh, 760px)" }}>
        <Hero3D />
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-between p-4 sm:p-6">
          <p className="micro font-medium">
            {L("Copy trading berjaminan", "Bonded copy trading")}
            <br />
            Monad · Perpl
          </p>
          <p className="micro text-right font-medium">
            {L("Pendekatan berbasis mandat", "A mandate-enforced")}
            <br />
            {L("untuk risiko", "approach to risk")}
          </p>
        </div>
        <div className="absolute bottom-4 left-4 z-10 flex items-center gap-2 sm:bottom-6 sm:left-6">
          <Link href="#leaders" className="micro rounded-full bg-[#121212] px-3 py-2 font-medium text-white hover:bg-black">
            {L("Lihat leader", "See leaders")} ↓
          </Link>
          <span className="micro hidden sm:inline">{L("Testnet live", "Live on testnet")} · {stats.leaders == null ? "registry read failed, reload" : `${stats.leaders} ${stats.leaders === 1 ? "leader" : "leaders"}`}</span>
        </div>
        <h1 className="display pointer-events-none absolute bottom-1 right-3 text-[22vw] leading-[0.78] tracking-[-0.03em] text-[#1a1a1a] sm:right-6 sm:text-[17vw] lg:text-[220px]">copas</h1>
      </section>

      {/* live protocol metrics: bond read from every LeaderBook, the rest counted from the indexer */}
      <section aria-label="Live protocol metrics" className="mx-2 rounded-[22px] border-[6px] border-black bg-[#111214] px-4 py-6 sm:mx-3 sm:px-8">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="micro text-ink-3">Live on Monad testnet</p>
          <p className="micro text-ink-3">{metrics ? "LeaderBook.bond() · Envio indexer" : "Indexer unavailable: onchain bond only"}</p>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { k: "AUSD bonded", v: stats.bond == null ? "–" : fmt(stats.bond), s: stats.leaders == null ? "registry read failed" : `across ${stats.leaders} ${stats.leaders === 1 ? "leader" : "leaders"}` },
            { k: "Active followers", v: metrics ? fmt(metrics.followers) : "–", s: "follows live now" },
            { k: "Copy syncs executed", v: metrics ? fmt(metrics.syncs) : "–", s: "Synced events onchain" },
            { k: "AUSD slashes paid", v: metrics ? metrics.slashPaid.toLocaleString("en-US", { maximumFractionDigits: metrics.slashPaid < 1 ? 4 : 2 }) : "–", s: metrics ? `${metrics.claims} ${metrics.claims === 1 ? "claim" : "claims"} by followers` : "" },
            { k: "Vaults created", v: metrics ? fmt(metrics.vaults) : "–", s: "one per follower" },
            { k: "Upkeep calls", v: metrics ? fmt(metrics.upkeep) : "–", s: "checkpoint · roll · sync" },
          ].map((m) => (
            <div key={m.k} className="min-w-0 border-l border-white/15 pl-3">
              <p className="display num truncate text-[34px] leading-none text-white sm:text-[40px]">{m.v}</p>
              <p className="micro mt-1.5 text-[#ff4a3d]">{m.k}</p>
              <p className="mt-0.5 text-[11px] text-ink-3">{m.s}</p>
            </div>
          ))}
        </div>
      </section>

      {/* manifesto */}
      <section className="mx-2 rounded-[22px] border-[6px] border-black bg-[#111214] px-4 py-16 text-center sm:mx-3 sm:py-24">
        <div className="bracket mx-auto inline-block py-2">
          <h2 className="display text-[clamp(40px,7vw,96px)] text-white">
            {L("Copy trader yang", "Copy traders with")}
            <br />
            {L("ikut menanggung risiko", "skin in the game")}
          </h2>
        </div>
        <p className="micro mt-5 text-ink-3">BOND | MANDATE | NO ORACLE | AUTO-SLASH | CLAIM | PASSKEY</p>
        <p className="mx-auto mt-6 max-w-xl text-[15px] leading-relaxed text-ink-2">
          {L(
            "Di Perpl, 71% trader rugi dalam 30 hari, dan leader terbaik pun bisa pergi kapan saja. Di Copas, leader yang mau diikuti harus menaruh uangnya sendiri. Kalau ingkar, follower yang dibayar.",
            "On Perpl, 71% of traders lose money within 30 days, and the best leader can leave at any time. On Copas, a leader who wants followers puts their own money on the line. Break the promise, and the followers get paid.",
          )}
        </p>
      </section>

      {/* numbered features */}
      <section className="mx-2 rounded-[22px] border-[6px] border-black bg-paper px-4 py-10 text-[#121212] sm:mx-3 sm:px-10">
        <h2 className="display text-center text-[clamp(34px,5.5vw,72px)]">{L("Cara kerjanya", "How it works")}</h2>
        <ol className="mt-8 divide-y divide-black/10">
          {steps.map((s) => (
            <li key={s.n} className="grid items-center gap-4 py-7 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,0.8fr)]">
              <div className="flex items-center gap-3">
                <span className="display text-2xl">{s.n}</span>
                <span className="dots flex-1 text-black/60" aria-hidden />
              </div>
              <div>
                <h3 className="display text-[28px] sm:text-[32px]">{s.t}</h3>
                <p className="mt-1 max-w-md text-sm leading-relaxed text-black/65">{s.d}</p>
              </div>
              <div className="md:text-right">
                <p className="display num text-[40px] text-[#e3241b] sm:text-[48px]">{s.k}</p>
                <p className="micro text-black/55">{s.kl}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* red CTA */}
      <section className="relative mx-2 overflow-hidden rounded-[22px] border-[6px] border-black bg-[#d81f16] px-4 py-16 text-center text-white sm:mx-3 sm:py-20">
        <div aria-hidden className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-black/15 blur-2xl" />
        <div aria-hidden className="absolute -bottom-28 -left-16 h-80 w-80 rounded-full bg-black/20 blur-2xl" />
        <p className="micro relative opacity-80">BOND | MANDATE | SLASH | CLAIM</p>
        <div className="bracket relative mx-auto mt-3 inline-block py-2">
          <h2 className="display text-[clamp(40px,6.5vw,88px)]">
            {L("Ikuti leader", "Follow a leader")}
            <br />
            {L("yang berjaminan", "who has a bond")}
          </h2>
        </div>
        <div className="relative mt-6 flex flex-wrap justify-center gap-2">
          <Link href="#leaders" className="micro rounded-full bg-white px-4 py-2.5 font-semibold text-[#121212] hover:bg-paper">
            {L("Pilih leader", "Pick a leader")} →
          </Link>
          <Link href="/become-leader" className="micro rounded-full border border-white/70 px-4 py-2.5 font-semibold hover:bg-white/10">
            {L("Jadi leader", "Become a leader")}
          </Link>
        </div>
      </section>
    </div>
  );
}
