// Kuru "new assets and markets" bounty: same live footage as bounty-kuru, framed as the asset class.
export default {
  scenes: [
    {
      id: "asset",
      vo: "This is a new asset class on Monad: a credit default swap on a trader. For each Copas leader and each epoch, the BreachMarket contract mints a pair of tokens, UP and DOWN, fully backed by AUSD. One AUSD mints one of each. At settlement, read from the leader's own LeaderBook, DOWN pays one AUSD if the leader broke the mandate, and UP pays if not.",
      frames: "bounty-kuru/intro",
    },
    {
      id: "market",
      vo: "Every epoch gets its own series, and DOWN gets its own market: a DOWN against AUSD order book on Kuru, deployed permissionlessly on testnet. The Copas keeper's market maker mints the series, lists it, and quotes both sides each epoch.",
      frames: "bounty-kuru/book",
    },
    {
      id: "trade",
      vo: "Anyone can trade it from a passkey wallet: here one AUSD buys DOWN on the Kuru book, a hedge against this leader breaking the mandate. The quote walks the book and includes Kuru's taker fee, and the order fills onchain at the quoted price.",
      frames: "bounty-kuru/trade",
    },
    {
      id: "tx",
      vo: "The fill on the Monad explorer: AUSD in, DOWN out.",
      frames: "bounty-kuru/tx",
    },
  ],
};
