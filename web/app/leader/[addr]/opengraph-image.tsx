import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import { getLeader } from "@/lib/copas/data";

// Shareable leader card for X / Farcaster / Telegram previews: live bond, mandate and status from the LeaderBook.
export const runtime = "nodejs";
export const revalidate = 300;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Copas bonded leader";

const font = () =>
  fetch("https://cdn.jsdelivr.net/fontsource/fonts/barlow-condensed@5.2.5/latin-500-normal.ttf")
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .catch(() => null);

export default async function Image({ params }: { params: Promise<{ addr: string }> }) {
  const { addr } = await params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) notFound();
  const [l, f] = await Promise.all([getLeader(addr).catch(() => null), font()]);
  const breached = l?.status === "breached";
  const stat = (k: string, v: string) => (
    <div style={{ display: "flex", flexDirection: "column", marginRight: 56 }}>
      <div style={{ fontSize: 22, letterSpacing: 2, color: breached ? "rgba(255,255,255,0.75)" : "#8a8a86" }}>{k}</div>
      <div style={{ fontSize: 76, color: "#f2f2f0", lineHeight: 1 }}>{v}</div>
    </div>
  );
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#000", padding: 14, fontFamily: "Barlow" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", borderRadius: 26, background: breached ? "#d81f16" : "#111214", padding: "40px 52px", position: "relative" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, letterSpacing: 2, color: breached ? "#fff" : "#8a8a86" }}>
            <div style={{ display: "flex" }}>BONDED COPY TRADING · MONAD</div>
            <div style={{ display: "flex" }}>{breached ? "MANDATE BROKEN · BOND SLASHED" : "BOND ON THE LINE"}</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 30, color: breached ? "#fff" : "#e3241b", letterSpacing: 2 }}>{`LEADER ${(l?.status ?? "unknown").toUpperCase()}`}</div>
            <div style={{ fontSize: 120, color: "#fff", lineHeight: 1 }}>{l?.name ?? `${addr.slice(0, 6)}…${addr.slice(-4)}`}</div>
          </div>
          <div style={{ display: "flex" }}>
            {stat("BOND", l ? `${l.bond.toFixed(0)} AUSD` : "—")}
            {stat("MAX DRAWDOWN", l ? `${l.maxDD}%` : "—")}
            {stat("MAX LEVERAGE", l ? `${l.maxLeverage}x` : "—")}
          </div>
          <div style={{ position: "absolute", right: 40, bottom: 6, fontSize: 210, color: breached ? "#ffffff" : "#e8e8e6", opacity: breached ? 0.25 : 0.12, lineHeight: 1 }}>COPAS</div>
        </div>
      </div>
    ),
    { ...size, fonts: f ? [{ name: "Barlow", data: f, weight: 500, style: "normal" }] : undefined },
  );
}
