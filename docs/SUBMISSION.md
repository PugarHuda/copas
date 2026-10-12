# Copas — submission notes

Paste-ready text for the Metropolis portal. Primary track: **Onchain Finance & Trading**.

## One-liner
Bonded copy trading on Monad: leaders post an AUSD bond and an onchain mandate; followers copy their Perpl perps positions through a vault they own; a breach slashes the bond to followers automatically, with no oracle and no admin.

## Short description (≈120 words)
On Perpl, 71% of traders lose money within 30 days, and copy-trading leaders risk nothing when they blow up their followers. Copas makes leaders put money on the line. A leader posts an AUSD bond and declares a mandate: max drawdown, leverage, size and markets. Followers sign in with a passkey (Mera, no seed phrase) and copy the leader through a FollowerVault they own. Anyone can call `sync()`, which can only move the vault toward ratio × the leader's live position inside the follower's own limits. Equity and drawdown are read from Perpl state in the same block. When a checkpoint sees a breach, the bond and fee escrow are slashed into a pot, and followers claim their real losses from it onchain.

## Links
- Repo: https://github.com/PugarHuda/copas
- Live app: https://copas-mocha.vercel.app — testnet 10143. Judges: create a passkey account, then use **Get testnet MON + AUSD** in the account menu.
- Demo video (≤3 min): _(link)_ · Pitch (≤2 min): _(link)_
- Services API: https://copas-services.vercel.app · Indexer: https://indexer.dev.hyperindex.xyz/042db7d/v1/graphql
- Keeper (copy-sync bot, Privy sponsored): https://github.com/PugarHuda/copas/actions/workflows/keeper.yml · E2E tests (Playwright, 70 tests vs production): https://github.com/PugarHuda/copas/actions/workflows/e2e.yml
- New 12 Oct: **mandate consent**. On Bybit, Binance or eToro a lead trader can change strategy, fee or risk under you, and you find out from your PnL. On Copas the leader's mandate change waits for the next epoch, shows on the leader page as a now/next table, and a follower vault (VaultFactory `0x09C8EBe6e0C3dBC517120aF497f757B23D36B6fb`, live in the registry) stops copying if the live terms are looser than what its owner accepted. The owner accepts in **Me**, or stays flat. The fee is always charged at the accepted rate. Six forge tests in `contracts/test/MandateConsent.t.sol`.
- New 12 Oct: **ERC-8004 reputation per epoch**. Agent leader #2209 has 5 feedback entries in the testnet ReputationRegistry (`0x8004B663…8713`), one per finished epoch, written by a Copas rater that is not the agent's owner (`keeper/scripts/reputation.ts`). The leader page reads them back: https://copas-mocha.vercel.app/leader/0xbC277432C927996E5F91a2D356289895e1415958
- Live pages worth a look: `/saved` (live Perpl losses vs what a Copas bond returns), `/seasons` (leaders ranked by follower outcome), `/proof` (real breach math + Privy DENY), `/become-leader` (Hyperliquid track-record import)
- Contracts: `contracts/deployments/10143.json` (registry `0xA8BA57c7Af1d9A28660653E0439A180c86D03e3d`, feed `0x75d52573C684C7799778Da633fDceB80297d7718`)

## Bounties

| Bounty | What uses it | Where | State |
|---|---|---|---|
| Best Community Team Project | Team from Ethereum Jakarta / DevWeb3Jogja | profile field | fill in portal |
| Perpl: Best use of Perpl's API | Contracts hold their own Perpl accounts and trade via `execOrder` (LeaderBook, FollowerVault). The long-running keeper (`pnpm start`) reacts to Perpl `Position*` events of leader accounts and syncs their followers; the hosted GitHub Actions tick syncs every vault each run. The web uses the public REST API: context, ticker, candles, funding, L2 book (`/v1/market-data/:id/book`) and leaderboard. Not used: the authenticated Ed25519 trading API (a contract-held Perpl account cannot sign the key enrollment) and the WebSocket (it answers 403 to browser origins other than Perpl's) | `contracts/src`, `keeper/`, `web/lib/perpl/api.ts` | live on testnet (trading), mainnet (REST data) |
| Perpl: Best Analytics / Risk Tool | Mainnet protocol and wallet risk dashboard: live markets, liquidation map and the positions closest to liquidation (onchain `getPosition` for every open position); **liquidity vs liquidation pressure** per market (book depth, $10K/$100K slippage, bids/asks within 5% vs the liquidations a 5% move triggers); **30-day funding heatmap** and **90-day OI by market** (Envio `MarketDaily`); **trader cohorts** by lifetime volume over every trader (Envio `Account`: 78% are net losers after fees, the top 1% take 79% of all profit, 12 Oct); full-history flows, liquidations and TVL proxy; wallet profiles and compare | `web/app/analytics`, `web/lib/perpl`, `indexer/` | live: https://copas-mocha.vercel.app/analytics |
| Kuru: New Assets and Markets | Per-leader breach-risk markets: BreachMarket mints UP/DOWN (a CDS on a trader), DOWN listed on a Kuru order book | `contracts/src/BreachMarket.sol`, `onramp/scripts/kuru-down-market.ts` | live on testnet: DOWN (leader `0xda69…`, epoch 2) at Kuru market `0x24d7B0c11D659478Bb17aAe7974CB1E088894EC2` with resting bid/ask and a fill; `/market/<leader>` reads it |
| Kuru: Consumer Trading App | Kuru Flow swap to AUSD inside deposit-and-follow | `onramp/` (F3) | quotes live |
| Envio | HyperIndex v3 on Envio Cloud: every Perpl Exchange event on Monad mainnet (72.5M events from block 54,773,010, synced to head through HyperSync) and testnet, plus the Copas contracts on testnet with dynamic registration (LeaderBook, FollowerVault, UnderwriterPool discovered from CopasRegistry). The web reads it for flows, liquidations, TVL, the funding heatmap, OI history, trader cohorts, wallet history, checkpoints, breaches and `/seasons`. The HyperSync query API is also called directly for Kuru fills on `/market` | `indexer/`, `web/lib/perpl/indexer.ts`, `web/lib/copas/kuru.ts` | Envio Cloud: https://indexer.dev.hyperindex.xyz/042db7d/v1/graphql (at chain head; analytics fall back to RPC only if it lags more than a day) |
| Aurora Intents | Any-chain deposit → USDC on Monad → Kuru swap → vault deposit | `onramp/` (F1) | live on 3 Oct; 1Click had no Monad liquidity on 11 Oct |
| Chainlink CRE | `copas-risk-guardian`: reads leaders, sanity-checks prices, scores risk, a consumer contract checkpoints risky leaders | `cre/`, `cre/SIMULATION.md` | simulated with `--broadcast` on testnet: report tx `0x28bdb9385d27536d9a42c42b993141a168fb295ced9a0954fd3ccbe392dfe878` to consumer `0xBc28c947e51572e55eeb0f988a068C7A0f4ec7b0` |
| Alchemy | Notify webhooks for keeper alerts | `keeper/` | needs Alchemy key in deploy |
| Mera: Best Mera-Powered UX | Passkey is the whole account layer: create/sign in, session for small actions, re-prompt for risky ones; no extension, no custody backend | `web/lib/mera` | live |
| Mera: One Passkey, Many Keys | Second PRF salt `sha256("copas.feed.v1")` → X25519 key → encrypted leader strategy notes readable only by followers, ciphertext onchain in `CopasFeed` | `web/lib/mera/feed.ts`, `web/components/StrategyFeed.tsx`, `contracts/src/CopasFeed.sol` | live on testnet |
| MetaMask: Best Agent Wallet Plugin | `mm copas`: 11 commands, mandatory risk limits, outflow cap | `plugin/` | works with Agent Wallet CLI |
| Privy | Keeper server wallet with policy: ALLOW `sync` (tx `0x66f9d7a7b7cb07a075e147e0e7dda414168266eb4c7d39f8e8095232d019332a`), DENY AUSD = `policy_violation` (shown on `/proof`) | `keeper/privy`, `keeper/logs/deny.json` | live on testnet, gas sponsored by Privy (Alchemy user op, e.g. tx `0x5ae7b07766c59591d80dfdc0d0018d0ad1cac5b3d86e44575d3890dbcf22b270`; keeper MON unchanged) |
| Nansen | Leader discovery and smart-money alignment (API key + x402) | `services/` (D2), hosted at https://copas-services.vercel.app/discover | live (API key, CDN-cached) |

Drop any row still marked "needs key" at submit time rather than claiming it.
