// Envio bounty: HyperIndex on Envio Cloud (Perpl mainnet + Copas testnet), queried live (out/captures/envio.txt).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CAP = path.join(path.dirname(fileURLToPath(import.meta.url)), "../out/captures");
const raw = fs.existsSync(path.join(CAP, "envio.txt")) ? fs.readFileSync(path.join(CAP, "envio.txt"), "utf8") : "";
const blocks = raw.split(/^\$ /m).filter(Boolean).map((s) => { const i = s.indexOf("\n"); return { cmd: s.slice(0, i), out: s.slice(i + 1), outMs: 2500 }; });
const H = (c, name) => c.page.getByRole("heading", { name }).first();

export default {
  scenes: [
    {
      id: "query",
      vo: "Copas indexes with Envio HyperIndex, hosted on Envio Cloud. One indexer covers every Perpl event on Monad mainnet, over seventy-three million so far, plus the Copas contracts on testnet. Here it answers live: the breach of epoch two with its slashed pot and claim, and the latest copy fills.",
      run: (c) => c.term(blocks, "Envio HyperIndex · GraphQL"),
    },
    {
      id: "analytics",
      vo: "The analytics dashboard reads it for capital flows, the thirty-day funding heatmap, ninety days of open interest, and trader cohorts across every Perpl account.",
      prep: async (c) => { await c.goto("/analytics", "Markets, live"); await c.sleep(4000); },
      run: async (c) => {
        await c.scrollTo(H(c, "Capital flows: deposits and withdrawals"), 1500);
        await c.sleep(1800);
        await c.scrollTo(H(c, "Funding heatmap, 30 days (daily average APR)"), 1500);
        await c.sleep(1800);
        await c.scrollTo(H(c, "Open interest by market, 90 days"), 1500);
        await c.sleep(1500);
        await c.scrollTo(H(c, "Trader cohorts: who makes money on Perpl"), 1500);
      },
    },
    {
      id: "checkpoints",
      vo: "On the Copas side, LeaderBooks, vaults and underwriter pools are discovered from the registry with dynamic contract registration. Every leader page lists its checkpoints and breaches from the indexer.",
      prep: (c) => c.goto("/leader/0xb1B08F6a0642c51b48c1916136458A769a1c5208", "Checkpoints and breaches"),
      run: async (c) => {
        await c.scrollTo(c.page.getByText("Checkpoints and breaches"), 2500);
        await c.move(c.page.getByText("Checkpoints and breaches"));
        await c.sleep(2500);
        await c.move([900, 500]);
      },
    },
    {
      id: "copyfill",
      vo: "And every follower vault shows an execution proof for each copy, from the indexed Synced events: the leader's position, the vault's move, the mark and the block.",
      prep: (c) => c.goto("/me?owner=0x914C0a0C1abfF8685f3db10b1A83899c379021d5", "Execution proof per copy"),
      run: async (c) => {
        await c.scrollTo("Execution proof per copy", 2000);
        await c.move(c.page.getByText("Execution proof per copy"));
        await c.sleep(2500);
        await c.move([900, 560]);
      },
    },
  ],
};
