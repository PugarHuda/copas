// Re-records the public fixtures used by the tests. Run: pnpm fixtures
// Nansen/Kimi/Tenderly fixtures are hand-written from their OpenAPI/docs (no keys at record time).
import { writeFileSync } from "node:fs";

const LEADER = "0xedcd7471aa1410353789c9f7c04be5192e3b409b";
const PLUMB = "https://plumb.huginn.tech/api/v1";
const out = (name: string, data: unknown) => writeFileSync(`test/fixtures/${name}.json`, JSON.stringify(data, null, 1));
const get = async (u: string) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u} ${r.status}`);
  return r.json() as Promise<any>;
};

const lb = await get("https://app.perpl.xyz/api/v1/trading/leaderboard/month/pnl");
// keep it small: top 40 + the fixture leader
lb.d = lb.d.filter((r: any, i: number) => i < 40 || r.a === LEADER);
out("perpl-leaderboard-month-pnl", lb);

const rows: any[] = [];
let next: string | null = null;
do {
  const page: any = await get(`${PLUMB}/wallets/${LEADER}/trades?limit=500${next ? `&before=${next}` : ""}`);
  rows.push(...page.rows);
  next = page.next;
} while (next && rows.length < 1500);
out("plumb-trades", { account: { address: LEADER }, rows });

const wallet = await get(`${PLUMB}/wallets/${LEADER}`);
out("plumb-wallet", wallet);

const r402 = await fetch("https://api.nansen.ai/api/v1/smart-money/netflow", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ chains: ["monad"] }),
});
out("nansen-402", { status: r402.status, paymentRequired: r402.headers.get("payment-required"), body: await r402.json() });
console.log("rows", rows.length);
