import type { Leader, LeaderStatus } from "@/lib/copas/contracts";
import { pct } from "@/lib/format";
import { Pill } from "./ui";

/** Max protection per SPEC §1.6: stake at risk ÷ follower AUM, capped at 100%. */
export const protection = (l: Pick<Leader, "bond" | "underwritten" | "followerAum">) =>
  l.followerAum > 0 ? Math.min(100, ((l.bond + l.underwritten) / l.followerAum) * 100) : 100;

export function StatusPill({ status, label }: { status: LeaderStatus; label: string }) {
  const tone = status === "active" ? "up" : status === "breached" ? "down" : status === "unbonded" ? "warn" : "neutral";
  const icon = status === "active" ? "●" : status === "breached" ? "✕" : status === "unbonded" ? "!" : "–";
  return (
    <Pill tone={tone}>
      <span aria-hidden>{icon}</span>
      {label}
    </Pill>
  );
}

/** Live drawdown against the declared cap. The track is the promise; the fill is how much of it is used. */
export function DDMeter({ live, max, compact = false }: { live: number; max: number; compact?: boolean }) {
  const used = Math.min(1, live / max);
  const color = used >= 1 ? "bg-down" : used >= 0.8 ? "bg-warn" : "bg-[var(--c1)]";
  return (
    <div className={compact ? "w-28" : "w-full"}>
      <div className="num flex justify-between text-xs">
        <span className={used >= 1 ? "text-down" : used >= 0.8 ? "text-warn" : "text-ink"}>{pct(live, 1)}</span>
        <span className="text-ink-3">/ {pct(max, 0)}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-sm bg-surface-2" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={live} aria-label="Drawdown used">
        <div className={`h-1.5 rounded-sm ${color}`} style={{ width: `${Math.max(2, used * 100)}%` }} />
      </div>
    </div>
  );
}
