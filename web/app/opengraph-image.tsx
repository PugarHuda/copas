import { ImageResponse } from "next/og";
import { getLeaders } from "@/lib/copas/data";

// Site card for shares of the home page: live totals from CopasRegistry, same look as the leader card.
export const runtime = "nodejs";
export const revalidate = 300;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Copas: bonded copy trading on Monad";

const font = () =>
  fetch("https://cdn.jsdelivr.net/fontsource/fonts/barlow-condensed@5.2.5/latin-500-normal.ttf")
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .catch(() => null);

export default async function Image() {
  const [ls, f] = await Promise.all([getLeaders().catch(() => null), font()]);
  const stake = ls ? ls.reduce((a, l) => a + l.bond + l.underwritten, 0) : null;
  const stat = (k: string, v: string) => (
    <div style={{ display: "flex", flexDirection: "column", marginRight: 56 }}>
      <div style={{ fontSize: 22, letterSpacing: 2, color: "#8a8a86" }}>{k}</div>
      <div style={{ fontSize: 76, color: "#f2f2f0", lineHeight: 1 }}>{v}</div>
    </div>
  );
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#000", padding: 14, fontFamily: "Barlow" }}>
        <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "space-between", borderRadius: 26, background: "#111214", padding: "40px 52px", position: "relative" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 22, letterSpacing: 2, color: "#8a8a86" }}>
            <div style={{ display: "flex" }}>BONDED COPY TRADING · MONAD · PERPL</div>
            <div style={{ display: "flex" }}>BREAK THE MANDATE, LOSE THE BOND</div>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 30, color: "#e3241b", letterSpacing: 2 }}>COPY TRADERS WITH SKIN IN THE GAME</div>
            <div style={{ fontSize: 120, color: "#fff", lineHeight: 1 }}>Copas</div>
          </div>
          <div style={{ display: "flex" }}>
            {stat("AT STAKE", stake == null ? "—" : `${stake.toFixed(0)} AUSD`)}
            {stat("LEADERS", ls ? String(ls.length) : "—")}
            {stat("ACTIVE", ls ? String(ls.filter((l) => l.status === "active").length) : "—")}
          </div>
          <div style={{ position: "absolute", right: 40, bottom: 6, fontSize: 210, color: "#e8e8e6", opacity: 0.12, lineHeight: 1 }}>COPAS</div>
        </div>
      </div>
    ),
    { ...size, fonts: f ? [{ name: "Barlow", data: f, weight: 500, style: "normal" }] : undefined },
  );
}
