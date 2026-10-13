// Perpl analytics / risk tool bounty: a walk through /analytics on Perpl mainnet data.
const H = (c, name) => c.page.getByRole("heading", { name }).first();

export default {
  scenes: [
    {
      id: "protocol",
      vo: "This is the Copas risk dashboard for Perpl on Monad mainnet, read straight from the exchange contract, Perpl's public API, and an Envio indexer over every Perpl event. At the top: volume, open interest, TVL, fees and active traders.",
      prep: async (c) => { await c.goto("/analytics", "Markets, live"); await c.sleep(5000); },
      run: async (c) => {
        await c.move(c.page.getByText("24h volume").first());
        await c.sleep(2500);
        await c.move(c.page.getByText("Open interest").first());
        await c.sleep(2000);
        await c.move(c.page.getByText("Active traders 24h").first());
        await c.sleep(1500);
        await c.scrollTo(H(c, "Daily volume"), 1500);
      },
    },
    {
      id: "markets",
      vo: "Every market, live: mark price, volume, open interest, traders long and short read from onchain positions, funding, and each market's insurance fund.",
      run: async (c) => {
        await c.scrollTo(H(c, "Markets, live"), 1800);
        await c.move(c.page.getByRole("columnheader", { name: /Open interest/ }).first());
        await c.sleep(2500);
        await c.move(c.page.getByRole("columnheader", { name: /Insurance fund/ }).first());
      },
    },
    {
      id: "flows",
      vo: "Capital flows over the full history, deposits against withdrawals. Then funding: the last three and a half days per market, and a thirty-day heatmap of daily average funding.",
      run: async (c) => {
        await c.scrollTo(H(c, "Capital flows: deposits and withdrawals"), 1800);
        await c.sleep(3000);
        await c.scrollTo(H(c, "Funding, last 3.5 days (APR)"), 1800);
        await c.sleep(2000);
        await c.scrollTo(H(c, "Funding heatmap, 30 days (daily average APR)"), 1800);
      },
    },
    {
      id: "liq",
      vo: "Open interest by market over ninety days, liquidations, and a liquidation map: where open positions would be liquidated, from onchain getPosition for every open position.",
      run: async (c) => {
        await c.scrollTo(H(c, "Open interest by market, 90 days"), 1800);
        await c.sleep(2500);
        await c.scrollTo(H(c, "Liquidation map"), 1800);
        await c.move([1000, 500]);
      },
    },
    {
      id: "book",
      vo: "Liquidity against liquidation pressure, per market: order book depth and slippage for ten and a hundred thousand dollars, next to the liquidations a five percent move would trigger.",
      run: async (c) => {
        await c.scrollTo(H(c, "Liquidity vs liquidation pressure"), 1800);
        await c.move(H(c, "Liquidity vs liquidation pressure"));
        await c.sleep(3000);
        await c.move([900, 500]);
      },
    },
    {
      id: "oracle",
      vo: "An oracle cross-check compares every Perpl mark with Pyth, Chainlink and Supra, read onchain in one multicall. Then the positions closest to liquidation, and the largest open positions.",
      run: async (c) => {
        await c.scrollTo(H(c, /Oracle check/), 1800);
        await c.sleep(3500);
        await c.scrollTo(H(c, "Positions closest to liquidation"), 1800);
        await c.move([700, 450]);
      },
    },
    {
      id: "cohorts",
      vo: "And trader cohorts: who actually makes money on Perpl, by lifetime volume, across every trader the indexer has seen. This is the evidence behind Copas: most traders lose, so a leader worth copying should have to post a bond.",
      run: async (c) => {
        await c.scrollTo(H(c, "Trader cohorts: who makes money on Perpl"), 2000);
        await c.move(H(c, "Trader cohorts: who makes money on Perpl"));
        await c.sleep(4000);
        await c.scrollTo(H(c, "Top traders, 30-day PnL"), 1800);
      },
    },
  ],
};
