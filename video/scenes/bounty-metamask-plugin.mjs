// MetaMask Agent Wallet bounty: real `mm copas` runs on Monad testnet, captured by video/capture-plugin.sh
// (command handlers via plugin/scripts/live.ts; the `mm` host itself needs an interactive `mm login`).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CAP = path.join(path.dirname(fileURLToPath(import.meta.url)), "../out/captures");
const read = (f) => (fs.existsSync(path.join(CAP, f)) ? fs.readFileSync(path.join(CAP, f), "utf8") : "");
// "$ mm copas <cmd>" sections of the capture, keyed by command line
const sections = read("plugin.txt").split(/^\$ /m).filter(Boolean).map((s) => { const i = s.indexOf("\n"); return { cmd: s.slice(0, i), out: s.slice(i + 1) }; });
const pick = (prefix, n = 0) => sections.filter((s) => s.cmd.startsWith(prefix))[n];
const cut = (out, max) => { const l = out.trimEnd().split("\n"); return l.length <= max ? out : `${l.slice(0, max).join("\n")}\n… (${l.length - max} more lines)`; };
const LB = "0xda695cB060c7e2dF0b5c36EA591eA69399463D90";

export default {
  scenes: [
    {
      id: "leaders",
      vo: "This is mm copas, a plugin for the MetaMask Agent Wallet, running for real against Monad testnet. Leaders lists every bonded leader in the Copas registry: bond, underwriters, protection as a share of follower money, live drawdown against the mandate, and the mandate itself.",
      run: (c) => { const s = pick("mm copas leaders"); return c.term([{ cmd: s.cmd, out: cut(s.out, 60), outMs: 4000 }], "mm copas · Monad testnet 10143"); },
    },
    {
      id: "leader",
      vo: "Leader shows one book in detail: fifty AUSD bond plus one hundred from underwriters, 0.03 percent drawdown against a fifteen percent limit, and its breach history, which is empty.",
      run: (c) => c.term([{ cmd: `mm copas leader ${LB}`, out: read("leader.txt"), outMs: 3000 }], "mm copas · Monad testnet 10143"),
    },
    {
      id: "vault",
      vo: "Now the agent creates its own follower vault and deposits 100 AUSD. Every write goes through the wallet executor with a plain intent, and each one is a real transaction.",
      run: (c) => c.term([pick("mm copas vault"), pick("mm copas deposit")].map((s) => ({ ...s, outMs: 1800 })), "mm copas · Monad testnet 10143"),
    },
    {
      id: "follow",
      vo: "Following without limits is refused. There are no default risk limits: the agent has to state max notional, leverage, chase, price band, stop-loss and markets. With all of them, and an explicit yes, the follow goes through.",
      run: (c) => c.term([pick("mm copas follow", 0), pick("mm copas follow", 1)].map((s) => ({ ...s, outMs: 2500, after: 1500 })), "mm copas · Monad testnet 10143"),
    },
    {
      id: "status",
      vo: "Sync asks the vault to move toward half the leader's position, inside those limits. Status reads the vault back: equity, high-water mark, and the limits it holds onchain.",
      run: (c) => c.term([pick("mm copas sync"), pick("mm copas status")].map((s) => ({ ...s, outMs: 2500 })), "mm copas · Monad testnet 10143"),
    },
    {
      id: "tighten",
      vo: "Limits can only be tightened from the plugin. Raising max leverage to three is refused. Lowering it to one is accepted and sent.",
      run: (c) => c.term([pick("mm copas tighten", 0), pick("mm copas tighten", 1)].map((s) => ({ ...s, outMs: 1800, after: 1200 })), "mm copas · Monad testnet 10143"),
    },
    {
      id: "withdraw",
      vo: "Withdrawals have a per-machine outflow cap, here twenty AUSD a day. The first fifteen go out. The next ten are refused before any transaction is built.",
      run: (c) => c.term([pick("mm copas withdraw", 0), pick("mm copas withdraw", 1)].map((s) => ({ ...s, outMs: 1800, after: 1200 })), "mm copas · Monad testnet 10143"),
    },
    {
      id: "claim",
      vo: "Claim pays a follower from a slashed bond, and only when the leader really breached. This leader did not, so the plugin says so. An agent can vet leaders first with the read-only Copas MCP server, then act here, inside these limits.",
      run: (c) => c.term([{ ...pick("mm copas claim"), outMs: 1200 }], "mm copas · Monad testnet 10143"),
    },
  ],
};
