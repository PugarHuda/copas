import Link from "next/link";
import type { ReactNode } from "react";

export function Panel({ title, aside, children, className = "", pad = true }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={`min-w-0 rounded-lg border border-line bg-surface ${className}`}>
      {(title || aside) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          {title && <h2 className="text-sm font-medium text-ink">{title}</h2>}
          {aside && <div className="flex flex-wrap items-center gap-2 text-xs text-ink-3">{aside}</div>}
        </header>
      )}
      <div className={pad ? "p-4" : ""}>{children}</div>
    </section>
  );
}

/** Label under value; value is the hero, label is quiet. */
export function Stat({ label, value, sub, tone = "" }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className={`num truncate text-xl font-medium tracking-tight sm:text-2xl ${tone}`}>{value}</div>
      <div className="mt-0.5 text-xs text-ink-3">{label}</div>
      {sub && <div className="num mt-1 text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

export function StatRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-3 lg:grid-cols-6">{children}</div>;
}

/** Marks where numbers come from. Every data surface carries one. */
export function Source({ kind, children }: { kind: "live" | "mock" | "indexer" | "rpc"; children: ReactNode }) {
  const dot = kind === "mock" ? "bg-warn" : "bg-up";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-3">
      <span aria-hidden className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      {children}
    </span>
  );
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "up" | "down" | "warn" | "gold" }) {
  const map = {
    neutral: "border-line-strong text-ink-2",
    up: "border-up/40 text-up",
    down: "border-down/40 text-down",
    warn: "border-warn/40 text-warn",
    gold: "border-gold/50 text-gold-2",
  };
  return <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs ${map[tone]}`}>{children}</span>;
}

export function Tabs({ items, active }: { items: { href: string; label: ReactNode; key: string }[]; active: string }) {
  return (
    <nav className="flex gap-1 border-b border-line" aria-label="Tabs">
      {items.map((it) => (
        <Link
          key={it.key}
          href={it.href}
          scroll={false}
          aria-current={active === it.key ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${active === it.key ? "border-gold text-ink" : "border-transparent text-ink-3 hover:text-ink-2"}`}
        >
          {it.label}
        </Link>
      ))}
    </nav>
  );
}

export function Segmented({ items, active }: { items: { href: string; label: ReactNode; key: string }[]; active: string }) {
  return (
    <div className="inline-flex rounded-md border border-line p-0.5 text-xs">
      {items.map((it) => (
        <Link
          key={it.key}
          href={it.href}
          scroll={false}
          aria-current={active === it.key ? "true" : undefined}
          className={`rounded px-2 py-1 ${active === it.key ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink-2"}`}
        >
          {it.label}
        </Link>
      ))}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-8 text-center text-sm text-ink-3">{children}</div>;
}

export function PageHead({ title, lede, children }: { title: ReactNode; lede?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="font-cond text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
        {lede && <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{lede}</p>}
      </div>
      {children}
    </div>
  );
}

/** Horizontal share bar for tables (magnitude, single hue). */
export function Bar({ value, max, className = "bg-[var(--c1)]" }: { value: number; max: number; className?: string }) {
  const w = max > 0 ? Math.max(1, (Math.abs(value) / max) * 100) : 0;
  return (
    <div className="h-1.5 w-full rounded-sm bg-surface-2" aria-hidden>
      <div className={`h-1.5 rounded-sm ${className}`} style={{ width: `${w}%` }} />
    </div>
  );
}

export const btn = {
  primary: "inline-flex items-center justify-center gap-2 rounded-md bg-gold px-4 py-2 text-sm font-medium text-gold-ink hover:bg-gold-2 disabled:cursor-not-allowed disabled:opacity-50",
  ghost: "inline-flex items-center justify-center gap-2 rounded-md border border-line-strong px-4 py-2 text-sm text-ink hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50",
};
