/** SPEC breach/slash math, mirrored from LeaderBook so anyone can recompute it. Contracts are canonical. */
export function breachMath(x: { equity: number; units: number; peak: number; maxDD: number; slash: number; capTotal: number; cap: number; loss: number }) {
  const unit = x.units > 0 ? x.equity / x.units : 0;
  const dd = x.peak > 0 ? Math.max(0, 1 - unit / x.peak) * 100 : 0;
  const breach = dd > x.maxDD;
  const claim = breach && x.capTotal > 0 ? Math.min((x.slash * x.cap) / x.capTotal, x.loss) : 0;
  return { unit, dd, breach, claim };
}
