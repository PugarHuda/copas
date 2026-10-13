// Chainlink CRE bounty: a real `cre workflow simulate` run (captured to out/captures/cre.txt) + the two earlier
// --broadcast report txs to CopasRiskConsumer (cre/SIMULATION.md).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CAP = path.join(path.dirname(fileURLToPath(import.meta.url)), "../out/captures");
const sim = fs.existsSync(path.join(CAP, "cre.txt")) ? fs.readFileSync(path.join(CAP, "cre.txt"), "utf8") : "";

export default {
  scenes: [
    {
      id: "sim",
      vo: "This is copas-risk-guardian, a Chainlink CRE workflow, simulated just now with the CRE CLI against Monad testnet. On a cron trigger it reads every leader from the Copas registry, checks Perpl's marks against an exchange price, scores each leader's risk, and writes one DON report to the Copas consumer contract. This run evaluated seven active leaders. The language model was rate limited, so it fell back to the deterministic heuristic score, which is the designed degradation.",
      run: (c) => c.term([{ cmd: "cre workflow simulate copas-risk-guardian -T testnet-settings --non-interactive --trigger-index 0", out: sim, outMs: 9000, pause: 1500 }], "cre · copas-risk-guardian"),
    },
    {
      id: "tx1",
      vo: "With the broadcast flag, the report lands onchain. This is the first report transaction to CopasRiskConsumer, with risk scored by the language model through median consensus across nodes.",
      prep: (c) => c.tx("0x28bdb9385d27536d9a42c42b993141a168fb295ced9a0954fd3ccbe392dfe878"),
      run: async (c) => { await c.move([700, 330], 1200); await c.sleep(3000); await c.scroll(350, 2000); },
    },
    {
      id: "tx2",
      vo: "And a second report covering four active leaders. When a leader is flagged as risky, the consumer calls checkpoint on its LeaderBook, so a breach is caught even if no one else calls it. It is simulated, not yet on a DON: our CRE account does not have deploy access.",
      prep: (c) => c.tx("0xd838a728ad8c00d40c305298c14a4e125d1194d11e6357ca3d0778eb50d60286"),
      run: async (c) => { await c.move([700, 330], 1200); await c.sleep(3000); await c.scroll(350, 2000); },
    },
  ],
};
