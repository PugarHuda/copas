// Privy bounty: the keeper is a Privy server wallet with a policy (ALLOW sync, DENY anything touching AUSD), gas sponsored.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const deny = fs.readFileSync(path.join(ROOT, "keeper/logs/deny.json"), "utf8");

export default {
  scenes: [
    {
      id: "actions",
      vo: "The Copas keeper is a Privy server wallet. It runs on GitHub Actions, ticking every five minutes, syncing follower vaults to their leaders and checkpointing every leader's mandate on Monad testnet.",
      prep: (c) => c.goto("https://github.com/PugarHuda/copas/actions/workflows/keeper.yml"),
      run: async (c) => { await c.move([700, 300], 1200); await c.sleep(3000); await c.scroll(250, 2000); },
    },
    {
      id: "proof",
      vo: "Its Privy policy allows only sync, checkpoint and roll epoch on Copas contracts. The proof page shows the DENY log: an approve on AUSD was refused by Privy with policy violation, before anything was signed.",
      prep: (c) => c.goto("/proof", "Privy policy DENY log"),
      run: async (c) => {
        await c.scrollTo(c.page.getByText("Privy policy DENY log"), 2000);
        await c.move(c.page.getByText("policy_violation").first());
        await c.sleep(3000);
        await c.move(c.page.getByText(/The keeper \(a Privy server wallet\)/));
      },
    },
    {
      id: "deny",
      vo: "This is the raw record from the keeper: wallet, policy ID, the exact call, and Privy's answer, status 400, policy violation.",
      run: (c) => c.term([{ cmd: "cat keeper/logs/deny.json", out: deny, outMs: 2500 }], "keeper"),
    },
    {
      id: "allow",
      vo: "The same wallet's allowed path: a sync call to a follower vault, signed by Privy and confirmed onchain.",
      prep: (c) => c.tx("0x66f9d7a7b7cb07a075e147e0e7dda414168266eb4c7d39f8e8095232d019332a"),
      run: async (c) => { await c.move([700, 330], 1200); await c.sleep(3000); await c.scroll(300, 1500); },
    },
    {
      id: "sponsored",
      vo: "And gas is sponsored: this keeper transaction went out as a user operation paid by Privy's sponsorship, so the keeper's own MON balance did not move.",
      prep: (c) => c.tx("0x5ae7b07766c59591d80dfdc0d0018d0ad1cac5b3d86e44575d3890dbcf22b270"),
      run: async (c) => { await c.move([700, 330], 1200); await c.sleep(3000); await c.scroll(300, 1500); },
    },
  ],
};
