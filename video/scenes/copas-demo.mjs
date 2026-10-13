// Technical demo (<= 3:00): the live product on Monad testnet. Numbers in the VO are the live values on 13 Oct 2026.
const GOOD = "0xda695cB060c7e2dF0b5c36EA591eA69399463D90";
const BREACHED = "0xb1B08F6a0642c51b48c1916136458A769a1c5208";
const SHORT = "0xE31302DA2B0dA7898416E630dA75c837139dBE1B";
const SHORT_OWNER = "0x914C0a0C1abfF8685f3db10b1A83899c379021d5";

export default {
  scenes: [
    {
      id: "intro",
      vo: "This is Copas: copy trading on Monad where every leader has money on the line. Everything you see is live, on Monad testnet, trading on Perpl.",
      prep: async (c) => { await c.goto("/", "AUSD LEADER BONDS"); await c.sleep(5000); },
      run: async (c) => {
        await c.sleep(3500);
        await c.scrollTo("AUSD LEADER BONDS", 1500);
        await c.move("AUSD LEADER BONDS");
      },
    },
    {
      id: "board",
      vo: "Each leader posts an AUSD bond and declares a mandate: maximum drawdown, leverage, size and markets. Seven leaders are live right now, with 380 AUSD at stake from bonds and underwriters.",
      run: async (c) => {
        await c.scrollTo("Bonds at stake", 2500);
        await c.move("Bonds at stake");
        await c.sleep(1500);
        await c.scroll(420, 2500);
        await c.move(c.page.getByText("DD ≤ 15%").first());
      },
    },
    {
      id: "leader",
      vo: "Here is one leader. Fifty AUSD of its own bond, plus one hundred from underwriters. The contracts check the mandate at every checkpoint: fifteen percent max drawdown, five x leverage, four markets. Equity is read straight from Perpl state in the same block. There is no oracle.",
      prep: (c) => c.goto(`/leader/${GOOD}`, "Max drawdown per epoch"),
      run: async (c) => {
        await c.move(c.page.getByText(/stakes \$50/).first());
        await c.sleep(3500);
        await c.scrollTo("Epoch summary", 2000);
        await c.move(c.page.getByText("Drawdown live / declared").first());
        await c.sleep(3000);
        await c.scrollTo(c.page.getByRole("heading", { name: "Mandate" }), 2000);
        await c.move("Max drawdown per epoch");
        await c.sleep(1500);
        await c.move("Allowed markets");
      },
    },
    {
      id: "follow",
      vo: "Following takes one passkey signature, with no seed phrase. The deposit goes into a vault the follower owns, not to the leader and not to us. The follower sets their own caps: copy ratio, max leverage, a vault stop-loss, and which markets to copy.",
      prep: (c) => c.goto(`/follow/${GOOD}`, "Copy settings"),
      run: async (c) => {
        await c.move("Copy settings");
        await c.sleep(2500);
        await c.move(c.page.getByText("Copy ratio (% of leader size)"));
        await c.sleep(1500);
        await c.scroll(250, 1500);
        await c.move(c.page.getByText("Max leverage").first());
        await c.sleep(1200);
        await c.move(c.page.getByText("Vault stop-loss (%)"));
        await c.sleep(1200);
        await c.move(c.page.getByText("Markets to copy"));
      },
    },
    {
      id: "short",
      vo: "Shorts are copied too. This leader opened a 0.0006 BTC short at five x on Perpl, from its LeaderBook contract.",
      prep: (c) => c.goto(`/leader/${SHORT}`, "Leader positions"),
      run: async (c) => {
        await c.scrollTo(c.page.getByText("Leader positions"), 2200);
        await c.move(c.page.getByRole("cell", { name: "Short" }).first());
      },
    },
    {
      id: "vault",
      vo: "And this is the follower's vault. It holds the same 0.0006 BTC short, one to one, entered within twenty dollars of the leader's price. Anyone can call sync, and sync can only move the vault toward the leader's position, inside the owner's limits.",
      prep: (c) => c.goto(`/me?owner=${SHORT_OWNER}`, "Copied positions"),
      run: async (c) => {
        await c.move(c.page.getByText(/following 0xE313/).first());
        await c.sleep(2500);
        await c.scrollTo("Copied positions", 1800);
        await c.move(c.page.getByRole("cell", { name: "-0.0006" }).first());
        await c.sleep(2500);
        await c.move(c.page.getByRole("cell", { name: "-0.0006" }).nth(1));
        await c.sleep(2000);
        await c.move(c.page.getByText(/Anyone can call sync/));
      },
    },
    {
      id: "breach",
      vo: "Now the case that matters. This leader broke its mandate in epoch two. The checkpoint read a drawdown of 0.022 percent against a declared limit of 0.01 percent, flagged the breach in the same transaction, and slashed its whole 25 AUSD bond into a pot. Its bond is now zero.",
      prep: (c) => c.goto(`/leader/${BREACHED}`, "Checkpoints and breaches"),
      run: async (c) => {
        await c.move(c.page.getByText("Unbonded").first());
        await c.sleep(2500);
        await c.scrollTo(c.page.getByText("Checkpoints and breaches"), 3500);
        const row = c.page.getByRole("row").filter({ hasText: /breach|Breach/ }).first();
        await c.move(row);
        await c.sleep(4000);
        await c.scroll(-2600, 2500);
        await c.move(c.page.getByText("Minimum bond"));
      },
    },
    {
      id: "proof",
      vo: "The follower vault unwound, and its owner claimed the real loss, about three cents, from that pot, paid onchain to their own wallet. No vote, no admin key. The proof page shows the same math, and Recompute derives it again from the inputs.",
      prep: (c) => c.goto("/proof", "Breaches and slashes"),
      run: async (c) => {
        await c.scrollTo("Breaches and slashes", 1800);
        await c.move(c.page.getByRole("cell", { name: "$0.03" }).first());
        await c.sleep(3000);
        await c.scrollTo("Reproducible math", 1800);
        await c.move(c.page.getByText(/claimᵢ/));
        await c.sleep(2500);
        await c.scrollTo(c.page.getByText("Recompute").first(), 1500);
        await c.click(c.page.getByRole("button", { name: "Reset to breach data" }));
        await c.move(c.page.getByText("dd > maxDD"));
      },
    },
    {
      id: "market",
      vo: "Every leader also has a breach market. One AUSD mints one UP and one DOWN. DOWN pays if the leader breaks the mandate, and it trades on a Kuru order book, so its price is the market's breach odds: three percent for this leader.",
      prep: (c) => c.goto(`/market/${GOOD}`, "Breach odds (DOWN price)"),
      run: async (c) => {
        await c.move(c.page.getByText(/Deposit 1 AUSD, get 1 UP/));
        await c.sleep(3500);
        await c.move("Breach odds (DOWN price)");
        await c.sleep(2500);
        await c.scrollTo(c.page.getByText("DOWN/AUSD order book (Kuru)"), 1500);
        await c.move(c.page.getByText("Best ask"));
        await c.sleep(1500);
        await c.move(c.page.getByText("Trade DOWN on Kuru"));
      },
    },
    {
      id: "analytics",
      vo: "Followers vet leaders with a full Perpl analytics dashboard on mainnet data: volume, open interest, funding, liquidations, and oracle cross-checks, read from the exchange contract and indexed by Envio.",
      prep: async (c) => { await c.goto("/analytics", "Markets, live"); await c.sleep(4000); },
      run: async (c) => {
        await c.move(c.page.getByText("24h volume").first());
        await c.sleep(1500);
        await c.scrollTo(c.page.getByRole("heading", { name: "Markets, live" }), 1800);
        await c.sleep(1200);
        await c.scrollTo(c.page.getByRole("heading", { name: "Funding heatmap, 30 days (daily average APR)" }), 2000);
        await c.sleep(1200);
        await c.scrollTo(c.page.getByRole("heading", { name: "Liquidation map" }), 1800);
        await c.sleep(1200);
        await c.scrollTo(c.page.getByRole("heading", { name: /Oracle check/ }), 1800);
      },
    },
    {
      id: "mobile",
      vo: "Copas is also a mobile app. A Mera passkey is the account and AUSD is the margin. This BTC long was checked against the trader's own mandate before the passkey signed, then filled on Perpl.",
      frames: "bounty-agora-mobile/long",
    },
    {
      id: "outro",
      vo: "The same flows run from the MetaMask Agent Wallet with mm copas, from AI agents through the Copas MCP server, and from the Telegram bot. Copas: copy traders with skin in the game.",
      run: async (c) => {
        await c.card(`<div class="t" style="font-size:40px;text-align:left;line-height:1.9">
          <div><span style="color:#f0b429">mm copas</span> &nbsp;MetaMask Agent Wallet plugin</div>
          <div><span style="color:#f0b429">copas-services.vercel.app/mcp</span> &nbsp;MCP server</div>
          <div><span style="color:#f0b429">@copas_monad_bot</span> &nbsp;Telegram</div></div>
          <div class="s" style="margin-top:60px">copas-mocha.vercel.app · github.com/PugarHuda/copas</div>`);
      },
    },
  ],
};
