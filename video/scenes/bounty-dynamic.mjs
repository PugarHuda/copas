// Dynamic bounty: a Dynamic server wallet operates a LeaderBook and trades on Perpl; a follower vault copies it;
// Copas enforces its own allowlist because Dynamic's policies do not validate Monad testnet.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const deny = fs.readFileSync(path.join(ROOT, "keeper/logs/dynamic-server-deny.json"), "utf8");
const SHORT = "0xE31302DA2B0dA7898416E630dA75c837139dBE1B";

export default {
  scenes: [
    {
      id: "leader",
      vo: "This leader is operated by a Dynamic server wallet, address 0x4071. The LeaderBook's operator can trade on Perpl for the book, and nothing else: it cannot withdraw the bond or the deposits.",
      prep: (c) => c.goto(`/leader/${SHORT}`, "Leader positions"),
      run: async (c) => {
        await c.move(c.page.getByText(/operator 0x4071/).first());
        await c.sleep(4000);
        await c.scrollTo(c.page.getByText("Leader positions"), 2000);
        await c.move(c.page.getByRole("cell", { name: "Short" }).first());
      },
    },
    {
      id: "trade",
      vo: "Here is the Dynamic wallet's trade: it called trade on the LeaderBook and grew the BTC short on Perpl from sixty to eighty lots, 0.0008 BTC.",
      prep: (c) => c.tx("0x7951d1e9abb096343a8576dc1dfe2e10fa7814a2e7453e5ecd0d411752be8c82"),
      run: async (c) => { await c.move([700, 330], 1200); await c.sleep(3000); await c.scroll(300, 1500); },
    },
    {
      id: "copy",
      vo: "The follower vault copied it one to one. The vault and the leader both hold 0.0008 BTC short, synced by the keeper minutes later.",
      prep: (c) => c.goto("/me?owner=0x914C0a0C1abfF8685f3db10b1A83899c379021d5", "Copied positions"),
      run: async (c) => {
        await c.scrollTo("Copied positions", 1500);
        await c.move(c.page.getByRole("cell", { name: "-0.0008" }).first());
        await c.sleep(2000);
        await c.move(c.page.getByRole("cell", { name: "-0.0008" }).nth(1));
      },
    },
    {
      id: "deny",
      vo: "Dynamic's transaction policies do not validate Monad testnet yet, so Copas enforces its own allowlist before the server wallet signs: only trade, checkpoint and roll epoch on this one LeaderBook. An AUSD approve from the same wallet was denied.",
      run: (c) => c.term([{ cmd: "cat keeper/logs/dynamic-server-deny.json", out: deny, outMs: 1500 }], "keeper"),
    },
    {
      id: "menu",
      vo: "In the app, Dynamic also gives followers an email wallet next to the passkey, and a delegated-access guard: a follower can let Copas sign exactly one call, unfollow on their own vault, when their leader breaches or loosens its mandate. Funds never move.",
      prep: (c) => c.goto("/", "AUSD LEADER BONDS"),
      run: async (c) => {
        await c.click(c.page.getByRole("banner").getByRole("button", { name: /Sign in with passkey/ }).first());
        await c.sleep(800);
        await c.move(c.page.getByRole("banner").getByRole("button", { name: /Email me a code/ }));
      },
    },
  ],
};
