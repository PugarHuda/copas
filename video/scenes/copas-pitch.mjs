// Pitch (<= 2:00): VO over the live product, plus a stat card. 71% figure: README.md / docs/SUBMISSION.md.
const GOOD = "0xda695cB060c7e2dF0b5c36EA591eA69399463D90";
const BREACHED = "0xb1B08F6a0642c51b48c1916136458A769a1c5208";

export default {
  scenes: [
    {
      id: "team",
      vo: "Copas is built by Pugar Huda Mantoro, from Indonesia, part of the Ethereum Jakarta and DevWeb3Jogja community.",
      prep: async (c) => { await c.goto("/", "AUSD LEADER BONDS"); await c.sleep(5000); },
      run: async (c) => { await c.sleep(1500); await c.move([1000, 500], 2500); },
    },
    {
      id: "problem",
      vo: "On Perpl, 71 percent of traders lose money within 30 days. Copy trading should help, but today the leader takes no risk. When a leader blows up, the followers pay, and the leader just opens a new account.",
      run: async (c) => {
        await c.card(`<div class="big">71%</div><div class="t">of Perpl traders lose money within 30 days</div>
          <div class="s" style="margin-top:80px;font-size:34px;color:#e6edf3">Copy trading today: the leader risks nothing.<br>When they blow up, followers pay.</div>`);
      },
    },
    {
      id: "solution",
      vo: "Copas flips that. To get followers, a leader posts an AUSD bond and declares a mandate. Break it, and the bond is slashed to the followers automatically, enforced by contracts that read Perpl directly. Followers keep custody in their own vault, signed with a passkey.",
      prep: (c) => c.goto(`/leader/${GOOD}`, "Max drawdown per epoch"),
      run: async (c) => {
        await c.move(c.page.getByText(/stakes \$50/).first());
        await c.sleep(4000);
        await c.scrollTo(c.page.getByRole("heading", { name: "Mandate" }), 2500);
        await c.move("Max drawdown per epoch");
        await c.sleep(3000);
        await c.move("Minimum bond");
      },
    },
    {
      id: "proof",
      vo: "This runs today on Monad testnet. A leader breached its mandate, its 25 AUSD bond was slashed, and the follower vault claimed its loss back onchain, with no human in the loop.",
      prep: (c) => c.goto("/proof", "Breaches and slashes"),
      run: async (c) => {
        await c.scrollTo("Breaches and slashes", 1500);
        await c.move(c.page.getByRole("cell", { name: "$25.00" }).first());
        await c.sleep(3000);
        await c.move(c.page.getByRole("cell", { name: "$0.03" }).first());
        await c.sleep(2000);
        await c.scrollTo("Reproducible math", 1800);
        await c.move(c.page.getByText(/claimᵢ/));
      },
    },
    {
      id: "monad",
      vo: "Why now? Monad is fast and cheap enough to copy every trade and check every mandate onchain, and Perpl's state can be read by contracts in the same block. Here a vault copies a leader's BTC short, one to one.",
      prep: (c) => c.goto("/me?owner=0x914C0a0C1abfF8685f3db10b1A83899c379021d5", "Copied positions"),
      run: async (c) => {
        await c.move(c.page.getByText(/following 0xE313/).first());
        await c.sleep(3000);
        await c.scrollTo("Copied positions", 1800);
        await c.move(c.page.getByRole("cell", { name: "-0.0006" }).first());
        await c.sleep(2000);
        await c.move(c.page.getByRole("cell", { name: "-0.0006" }).nth(1));
      },
    },
    {
      id: "who",
      vo: "We are building for retail stablecoin savers in Southeast Asia, who live on their phones and want a strategy they can understand. Leaders get a public track record they cannot fake.",
      frames: "bounty-agora-mobile/rail",
    },
    {
      id: "close",
      vo: "Copy trading where the leader has skin in the game. That's Copas.",
      run: async (c) => {
        await c.card(`<div class="big" style="color:#e6edf3">COPAS</div><div class="t">Copy traders with skin in the game.</div>
          <div class="s">copas-mocha.vercel.app · github.com/PugarHuda/copas</div>`);
      },
    },
  ],
};
