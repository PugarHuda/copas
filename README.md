# Copas — bonded copy trading on Monad

> Monad Metropolis Hackathon · Track 01 Onchain Finance & Trading

**On Perpl, 71% of traders lose money within 30 days, and the best leader can pull out at any time. On Copas, a leader who wants followers has to put their own money on the line. If they break their word, the followers get paid.**

Every leader posts an **AUSD bond** and declares a **mandate**: max drawdown, allowed markets, max leverage and size. Followers copy the leader's Perpl perps positions through a vault they own, and that vault can only copy within the follower's own limits. The contracts read the leader's equity **directly from Perpl state, with no oracle**. If the leader breaches the mandate, the bond is **slashed automatically and paid to followers** in proportion to their real losses.

## Design rules

1. **The backend never holds follower funds.** Funds sit in a `FollowerVault` owned by the follower's passkey EOA, and withdrawals only go to that owner.
2. **Copy-only.** Anyone can call `sync()`, but it can only move the follower toward `ratio × leader position`, within the follower's caps, stop-loss and leverage limit. Bots have no discretion.
3. **No oracle for money logic.** Equity, drawdown, breach and settlement all come from Perpl views read in the same block.
4. **AI explains, rules execute.** Kimi produces signed risk analysis. Every action is deterministic contract logic.
5. **Honest risk.** The UI always shows *max protection = bond / follower AUM* and the remaining risks. The contracts are unaudited, so mainnet deposits are capped.

## Repository

| Folder | What | Sponsor tech |
|---|---|---|
| [`contracts/`](contracts) | `CopasRegistry`, `LeaderBook` (units, epochs, mandate, bond, breach), `FollowerVault` (copy-only sync, caps, claims, referral), `UnderwriterPool`, `BreachMarket` (UP/DOWN per leader epoch), `AgentLeaderRegistry`. Unit, invariant and mainnet-fork tests | Monad, Perpl, AUSD, ERC-8004 |
| [`web/`](web) | Next.js app: bonded leaderboard, leader profile, follow ticket, vault, become-leader, underwrite, DOWN market, proof page with reproducible breach math, plus a full **Perpl analytics and risk dashboard** (protocol and wallet level) | Mera passkeys, Perpl, Envio |
| [`indexer/`](indexer) | Envio HyperIndex v3: all Perpl fill, position, liquidation, funding and collateral events plus aggregates, and the Copas contracts via dynamic registration | Envio |
| [`keeper/`](keeper) | Copy sync, checkpoint and epoch bot; Privy server wallet with policy, gas sponsorship and a DENY demo; ERC-8004 feedback; alerts | Privy, Alchemy, Telegram |
| [`services/`](services) | Backtest using the same math as the contracts, Kimi risk analyst with signatures, Nansen discovery (API key + x402), tx simulation, track-record attestation | Kimi, Nansen, Tenderly |
| [`cre/`](cre) | Chainlink CRE workflow `copas-risk-guardian`: reads leaders, sanity-checks prices, asks Kimi for a structured risk score, then a consumer contract checkpoints risky leaders | Chainlink CRE |
| [`onramp/`](onramp) | Any-chain deposit-and-follow via Aurora 1Click / Intents Connect recipe, Kuru Flow swap to AUSD, Socket V3 deposit address, Kuru market script for DOWN tokens | Aurora, Kuru, Socket |
| [`plugin/`](plugin) | MetaMask Agent Wallet plugin `mm copas` (11 commands, mandatory risk limits, outflow cap) | MetaMask |
| [`docs/`](docs) | [`SPEC.md`](docs/SPEC.md) (product and technical spec) and [`STATUS.md`](docs/STATUS.md) (feature tracker) | |

Each app folder has its own README with setup, env vars, and what is live versus mocked. Deployed contract addresses go in `contracts/deployments/`.

## Quick start

```bash
# contracts
cd contracts && forge test

# web (http://localhost:3000)
cd web && pnpm install && pnpm dev

# indexer (WSL/Linux + Docker; needs ENVIO_API_TOKEN)
cd indexer && pnpm install && pnpm codegen && pnpm dev
```

Monad mainnet is chain `143` and Monad testnet is `10143`. Perpl Exchange on mainnet: `0x34B6552d57a35a1D042CcAe1951BD1C370112a6F`.
