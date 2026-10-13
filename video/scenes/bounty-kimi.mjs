// Kimi bounty: the leader risk analysis is written by Kimi K3 and signed; the contract still enforces the mandate.
// The API response was fetched once into out/captures/kimi.txt (each call costs ~$0.008).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CAP = path.join(path.dirname(fileURLToPath(import.meta.url)), "../out/captures");
const out = fs.existsSync(path.join(CAP, "kimi.txt")) ? fs.readFileSync(path.join(CAP, "kimi.txt"), "utf8") : "";
const GOOD = "0xda695cB060c7e2dF0b5c36EA591eA69399463D90";

export default {
  scenes: [
    {
      id: "panel",
      vo: "Every Copas leader page has an AI risk analysis, written by Kimi K3. It reads the leader's real Perpl fills and explains the trading style, signs of tilt or drift, a weekly summary, and the reasons not to follow. The numbers are deterministic; the AI explains, and the contract enforces.",
      prep: async (c) => { await c.goto(`/leader/${GOOD}`, "AI risk analysis"); await c.sleep(4000); },
      run: async (c) => {
        await c.scrollTo(c.page.getByText("AI risk analysis").first(), 2000);
        await c.move(c.page.getByText("AI risk analysis").first());
        await c.sleep(3500);
        await c.move(c.page.getByText("Reasons not to follow").first());
        await c.sleep(3000);
        await c.move([900, 560]);
      },
    },
    {
      id: "api",
      vo: "Behind it is the Copas services API. The raw response carries the analysis, the model, kimi-k3, and Kimi's own request signature, checked against Moonshot's verify endpoint: signature valid, true. It also records token usage, the cost of this call, under one cent, and hashes of the input and output.",
      run: (c) => c.term([{ cmd: `curl -s https://copas-services.vercel.app/leader/${GOOD}/analysis | jq`, out, outMs: 9000, pause: 800 }], "Copas services API"),
    },
    {
      id: "doc",
      vo: "The write-up in the repo explains the design: Kimi explains, the contract enforces, and every answer is signed and verifiable.",
      prep: (c) => c.goto("https://github.com/PugarHuda/copas/blob/master/docs/KIMI.md"),
      run: async (c) => { await c.move([800, 400], 1200); await c.sleep(2000); await c.scroll(500, 3000); },
    },
  ],
};
