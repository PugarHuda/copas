# Copas — submission notes

Paste-ready text for the Metropolis portal. Primary track: **Onchain Finance & Trading**.

## One-liner
Bonded copy trading on Monad: leaders post an AUSD bond and an onchain mandate; followers copy their Perpl perps positions through a vault they own; a breach slashes the bond to followers automatically, with no oracle and no admin.

## Short description (≈120 words)
On Perpl, 71% of traders lose money within 30 days, and copy-trading leaders risk nothing when they blow up their followers. Copas makes leaders put money on the line. A leader posts an AUSD bond and declares a mandate: max drawdown, leverage, size and markets. Followers sign in with a passkey (Mera, no seed phrase) and copy the leader through a FollowerVault they own. Anyone can call `sync()`, which can only move the vault toward ratio × the leader's live position inside the follower's own limits. Equity and drawdown are read from Perpl state in the same block. When a checkpoint sees a breach, the bond and fee escrow are slashed into a pot, and followers claim their real losses from it onchain.

## Links
- Repo: https://github.com/PugarHuda/copas
- Live app: _(Vercel URL)_ — testnet 10143. Judges: create a passkey account, then use **Get testnet MON + AUSD** in the account menu.
- Demo video (≤3 min): _(link)_ · Pitch (≤2 min): _(link)_
- Contracts: `contracts/deployments/10143.json` (registry `0xA8BA57c7Af1d9A28660653E0439A180c86D03e3d`, feed `0x75d52573C684C7799778Da633fDceB80297d7718`)

## Bounties

| Bounty | What uses it | Where | State |
|---|---|---|---|
| Best Community Team Project | Team from Ethereum Jakarta / DevWeb3Jogja | profile field | fill in portal |
| Perpl: Best use of Perpl's API | Contracts hold their own Perpl accounts and trade via `execOrder`; the keeper is a copy-sync bot over Perpl events | `contracts/src`, `keeper/` | live on testnet |
| Perpl: Best Analytics / Risk Tool | Protocol and wallet risk dashboard: PnL, liquidations, funding, TVL, flows | `web/app/analytics`, `indexer/` | live (mainnet data) |
| Kuru: New Assets and Markets | Per-leader breach-risk markets: BreachMarket mints UP/DOWN (a CDS on a trader), DOWN listed on a Kuru order book | `contracts/src/BreachMarket.sol`, `onramp/scripts/kuru-down-market.ts` | contract live; Kuru market script simulated |
| Kuru: Consumer Trading App | Kuru Flow swap to AUSD inside deposit-and-follow | `onramp/` (F3) | quotes live |
| Envio | HyperIndex for all Perpl events plus Copas contracts (dynamic registration); HyperSync used for history scans | `indexer/` | live locally; Envio Cloud _(URL)_ |
| Aurora Intents | Any-chain deposit → USDC on Monad → Kuru swap → vault deposit | `onramp/` (F1) | live on 3 Oct; 1Click had no Monad liquidity on 11 Oct |
| Chainlink CRE | `copas-risk-guardian`: reads leaders, sanity-checks prices, scores risk, a consumer contract checkpoints risky leaders | `cre/` | simulated |
| Alchemy | Notify webhooks for keeper alerts | `keeper/` | needs Alchemy key in deploy |
| Mera: Best Mera-Powered UX | Passkey is the whole account layer: create/sign in, session for small actions, re-prompt for risky ones; no extension, no custody backend | `web/lib/mera` | live |
| Mera: One Passkey, Many Keys | Second PRF salt `sha256("copas.feed.v1")` → X25519 key → encrypted leader strategy notes readable only by followers, ciphertext onchain in `CopasFeed` | `web/lib/mera/feed.ts`, `web/components/StrategyFeed.tsx`, `contracts/src/CopasFeed.sol` | live on testnet |
| MetaMask: Best Agent Wallet Plugin | `mm copas`: 11 commands, mandatory risk limits, outflow cap | `plugin/` | works with Agent Wallet CLI |
| Privy | Keeper server wallet with policy, gas sponsorship, DENY demo | `keeper/privy` | needs Privy app keys |
| Nansen | Leader discovery and smart-money alignment (API key + x402) | `services/` (D2) | needs Nansen key |
| Kimi | Signed risk analysis per leader | `services/` (D1) | needs Kimi key |

Drop any row still marked "needs key" at submit time rather than claiming it.
