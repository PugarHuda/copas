import { usd } from "@/lib/format";

/**
 * The bond seal. Modeled on the Indonesian "materai" revenue stamp: a stamp
 * is what makes a written promise binding. Shows the bond and the promised
 * drawdown cap; a breached leader's seal is voided.
 */
export function Seal({ bond, maxDD, breached = false, size = "md", label }: { bond: number; maxDD: number; breached?: boolean; size?: "sm" | "md" | "lg"; label?: string }) {
  const dims = { sm: "w-[92px] p-2.5", md: "w-[124px] p-3", lg: "w-[168px] p-4" }[size];
  const big = { sm: "text-lg", md: "text-2xl", lg: "text-[34px]" }[size];
  return (
    <div className={`perforated relative shrink-0 ${breached ? "bg-[#3a2228]" : "bg-[#2a2412]"} ${dims}`} aria-label={`Bond ${usd(bond, { dp: 0 })}, max drawdown ${maxDD}%${breached ? ", breached" : ""}`}>
      <div className={`guilloche relative rounded-[2px] border ${breached ? "border-down/50" : "border-gold/50"} px-2 py-2 text-center`}>
        <div className={`text-[10px] ${breached ? "text-down" : "text-gold-2"}`}>{label ?? "AUSD bond"}</div>
        <div className={`num font-cond font-semibold leading-none ${big} ${breached ? "text-down line-through decoration-2" : "text-gold-2"}`}>{usd(bond, { dp: 0, compact: true }).replace("$", "")}</div>
        <div className={`mt-1.5 border-t ${breached ? "border-down/40" : "border-gold/40"} pt-1 text-[10px] text-ink-2`}>
          DD ≤ <span className="num text-ink">{maxDD}%</span>
        </div>
      </div>
    </div>
  );
}
