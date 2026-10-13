// Aurora Intents bounty: the hosted onramp (copas-onramp.vercel.app) quoting Base USDC -> USDC on Monad through 1Click,
// called live into out/captures/aurora.txt, and the "Fund from any chain" panel in deposit-and-follow.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CAP = path.join(path.dirname(fileURLToPath(import.meta.url)), "../out/captures");
const raw = fs.existsSync(path.join(CAP, "aurora.txt")) ? fs.readFileSync(path.join(CAP, "aurora.txt"), "utf8") : "";
const blocks = raw.split(/^\$ /m).filter(Boolean).map((s) => { const i = s.indexOf("\n"); return { cmd: s.slice(0, i), out: s.slice(i + 1), outMs: 2000, after: 900 }; });
const GOOD = "0xda695cB060c7e2dF0b5c36EA591eA69399463D90";

export default {
  scenes: [
    {
      id: "quote",
      vo: "Copas lets a follower fund from any chain with Aurora Intents. Our onramp service is live and uses Aurora's public 1Click host. Asked for ten USDC on Base, it quotes 9.977 USDC delivered on Monad, in about thirty-seven seconds.",
      run: (c) => c.term(blocks.slice(0, 2), "copas-onramp · Aurora 1Click"),
    },
    {
      id: "deposit",
      vo: "Then it opens a deposit address for that quote. The user sends USDC on Base to it, and the status endpoint tracks the intent from awaiting deposit to delivered. Nothing was sent here, so it waits for the deposit.",
      run: (c) => c.term(blocks.slice(2), "copas-onramp · Aurora 1Click"),
    },
    {
      id: "follow",
      vo: "In the app, this sits inside deposit and follow. Pick a source chain and token, get a live quote, and the USDC lands at the follower's Mera address on Monad, where a Kuru swap turns it into AUSD for the vault. During the hackathon the vaults run on testnet, so this mainnet USDC does not reach a testnet vault yet.",
      prep: (c) => c.goto(`/follow/${GOOD}`, "Fund from any chain"),
      run: async (c) => {
        await c.scrollTo(c.page.getByText("Fund from any chain"), 2000);
        await c.move(c.page.getByText("Fund from any chain"));
        await c.sleep(3000);
        await c.move(c.page.getByText(/Bring USDC, ETH, USDT or SOL/));
        await c.sleep(3000);
        const btn = c.page.getByRole("button", { name: "Get quote" });
        await c.click(btn);
        await c.sleep(6000);
        await c.move(btn);
      },
    },
  ],
};
