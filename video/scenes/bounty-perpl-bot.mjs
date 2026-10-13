// Perpl bot bounty: the hosted keeper (GitHub Actions) syncing follower vaults to their leaders' Perpl positions.
// Log excerpt captured with `gh run view 38398991594 --log` into out/captures/keeper.txt.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CAP = path.join(path.dirname(fileURLToPath(import.meta.url)), "../out/captures");
const log = fs.existsSync(path.join(CAP, "keeper.txt")) ? fs.readFileSync(path.join(CAP, "keeper.txt"), "utf8") : "";
const SHORT = "0xE31302DA2B0dA7898416E630dA75c837139dBE1B";

export default {
  scenes: [
    {
      id: "actions",
      vo: "Copas runs a copy-trading bot for Perpl. The keeper is hosted on GitHub Actions: each run ticks every five minutes, from a Privy server wallet with gas sponsored, and it can only call sync, checkpoint and roll epoch.",
      prep: (c) => c.goto("https://github.com/PugarHuda/copas/actions/workflows/keeper.yml", "keeper"),
      run: async (c) => {
        await c.move(c.page.getByRole("link", { name: /keeper/ }).nth(1));
        await c.sleep(3000);
        await c.scroll(250, 2000);
        await c.move([800, 500]);
      },
    },
    {
      id: "log",
      vo: "Here is one tick from that run's log. It reads seven leaders and fourteen vaults from the registry, sends checkpoints that measure each leader's drawdown from Perpl state, and then syncs the one vault whose position no longer matches its leader.",
      run: (c) => c.term([{ cmd: "gh run view 38398991594 --log   # keeper tick, 13 Oct 17:22 UTC", out: log, outMs: 5000, pause: 800 }], "keeper · GitHub Actions log"),
    },
    {
      id: "leader",
      vo: "Why? This leader's operator had just grown its BTC short on Perpl, from 0.0006 to 0.0008 BTC. The LeaderBook contract holds its own Perpl account and trades through execOrder.",
      prep: (c) => c.goto(`/leader/${SHORT}`, "Leader positions"),
      run: async (c) => {
        await c.move(c.page.getByText(/operator 0x4071/).first());
        await c.sleep(2500);
        await c.scrollTo(c.page.getByText("Leader positions"), 2000);
        await c.move(c.page.getByRole("cell", { name: "Short" }).first());
      },
    },
    {
      id: "vault",
      vo: "The keeper's sync moved the follower vault to match, one to one: the vault and the leader both hold 0.0008 BTC short. Every copy is recorded onchain as a Synced event, shown here from the Envio indexer.",
      prep: (c) => c.goto("/me?owner=0x914C0a0C1abfF8685f3db10b1A83899c379021d5", "Copied positions"),
      run: async (c) => {
        await c.scrollTo("Copied positions", 1500);
        await c.move(c.page.getByRole("cell", { name: "-0.0008" }).first());
        await c.sleep(2000);
        await c.move(c.page.getByRole("cell", { name: "-0.0008" }).nth(1));
        await c.sleep(2000);
        await c.scrollTo("Execution proof per copy", 1500);
        await c.move(c.page.getByText("Execution proof per copy"));
      },
    },
    {
      id: "tx",
      vo: "And this is the keeper's sync transaction on the explorer. Anyone can call sync, and it can only move a vault toward the ratio times the leader's live Perpl position, inside the owner's limits.",
      prep: (c) => c.tx("0x0899fe22b1bbe93188134d2f98cc6f7ea57cdce3d5618cbf1bca49026ac5fdfb"),
      run: async (c) => { await c.move([700, 330], 1200); await c.sleep(3500); await c.scroll(300, 2000); },
    },
  ],
};
