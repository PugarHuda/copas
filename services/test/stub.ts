// Fixture-backed fetch: routes every external URL used by the services to a recorded/synthetic fixture.
import { readFileSync } from "node:fs";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}.json`, import.meta.url), "utf8"));
export const LEADER = "0xedcd7471aa1410353789c9f7c04be5192e3b409b";
export const NOW = 1791043620; // plumb meta.ts at record time
export const trades = () => fx("plumb-trades").rows as any[];
export const nansen = fx("nansen-synthetic");
export const nansen402 = fx("nansen-402");
export const calls: string[] = [];

export const stubFetch: typeof fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  calls.push(url);
  const json = (b: unknown, headers: Record<string, string> = {}, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json", ...headers } });
  if (url.includes("app.perpl.xyz/api/v1/trading/leaderboard/")) return json(fx("perpl-leaderboard-month-pnl"));
  const t = url.match(/plumb\.huginn\.tech\/api\/v1\/wallets\/(0x[0-9a-f]+)\/trades\?(.*)$/i);
  if (t) {
    const q = new URLSearchParams(t[2]);
    const from = Number(q.get("from") ?? 0);
    const to = Number(q.get("to") ?? Infinity);
    const rows = t[1].toLowerCase() === LEADER ? trades().filter((r) => r.ts >= from && r.ts <= to) : [];
    return json({ rows, next: null });
  }
  const n = url.match(/api\.nansen\.ai\/api\/v1\/(.+)$/);
  if (n) {
    const h = new Headers(init?.headers);
    if (!h.get("apikey") && !h.get("payment-signature")) return json(nansen402.body, { "payment-required": nansen402.paymentRequired }, 402);
    const extra: Record<string, string> = h.get("apikey") ? { "x-nansen-credits-cost": n[1].startsWith("smart-money") ? "5" : "1" } : {};
    return json(nansen[n[1]], extra);
  }
  if (url.endsWith("/chat/completions")) {
    return json(fx("kimi-chat"), { "Msh-Request-Timestamp": "1791043700000", "Msh-Request-Signature": "reqsigv1_fixture" });
  }
  if (url.endsWith("/signatures/verify")) {
    const b = JSON.parse(String(init?.body));
    return json({ valid: b.signature === "reqsigv1_fixture" && b.model === "kimi-k3" });
  }
  if (url.includes("api.tenderly.co")) return json(fx("tenderly-simulate"));
  return new Response(`no fixture for ${url}`, { status: 599 });
};
