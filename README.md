# Copas — bonded copy trading on Monad

> Monad Metropolis Hackathon · Track 01 Onchain Finance & Trading

**On Perpl, 71% of traders lose money within 30 days, and the best leader can pull out at any time. On Copas, a leader who wants followers has to put their own money on the line. If they break their word, the followers get paid.**

Every leader posts an **AUSD bond** and declares a **mandate**: max drawdown, allowed markets, max leverage and size. Followers copy the leader's Perpl perps positions through a vault they own, and that vault can only copy within the follower's own limits. The contracts read the leader's equity **directly from Perpl state, with no oracle**. If the leader breaches the mandate, the bond is **slashed automatically and paid to followers** in proportion to their real losses.

## Links

- Live app: https://copas-mocha.vercel.app (Monad testnet 10143) · Telegram bot: https://t.me/copas_monad_bot · MCP server for agents: https://copas-services.vercel.app/mcp
- Demo video (2:52): https://youtu.be/9AINu2cNK_U · Pitch (1:19): https://youtu.be/qoZFOktrv0s · One clip per sponsor integration: https://drive.google.com/drive/folders/1LtR9Z6OfxjYJTCVjmjWksxV-_wH3sNAa
- Evidence for every claim (tx hashes, addresses): [`docs/SUBMISSION.md`](docs/SUBMISSION.md) · Feature tracker: [`docs/STATUS.md`](docs/STATUS.md) · Security review: [`contracts/SECURITY.md`](contracts/SECURITY.md)

> **Note for judges: indexer endpoint moved on 19 Oct 2026.** Envio's Development tier scheduled the original deployment (`042db7d`) for auto-disable over its event limits, and Envio support told us to create a new deployment to reset it. The new endpoint is https://indexer.dev.hyperindex.xyz/003f7d8/v1/graphql. Its indexer code is unchanged: commit `242ef36` has the same `indexer/` code as the original deployment (`ac9388b`). It re-synced from scratch and reached chain head the same day, at 10:28 GMT+7 on 19 Oct 2026: 75.07M mainnet events and 1.75M testnet events. The commit that adds this note only changes the endpoint URL and docs.

## Sponsor integrations (all live)

| Sponsor | What Copas does with it |
|---|---|
| Perpl | Contracts hold their own Perpl accounts and trade via `execOrder`; the keeper copies leaders' longs and shorts into follower vaults; risk and analytics dashboard over all Perpl history |
| Kuru | Per-leader DOWN tokens (a CDS on a trader, paid out if the leader breaches) on Kuru order books, quoted by our market maker, tradable from the passkey wallet |
| Agora (AUSD) + Mera | Installable mobile app: passkey account, AUSD balance cross-checked three ways, Perpl orders gated by the trader's own mandate |
| Mera (Many Keys) | A second PRF key encrypts leader strategy notes onchain that only current followers can decrypt |
| Privy | Keeper server wallet with an ALLOW/DENY policy and gas sponsorship: the automation can sync vaults but provably can't move money |
| Dynamic | MPC wallets as LeaderBook operators (one traded on Perpl behind a Copas allowlist), email wallets, an unfollow-only delegated guard |
| Envio | HyperIndex over every Perpl event (72.5M on mainnet) + Copas contracts via dynamic registration; HyperSync for Kuru fills |
| Chainlink CRE | `copas-risk-guardian` workflow: reads leaders, scores risk, a consumer contract checkpoints risky leaders (simulated with onchain broadcast) |
| Aurora Intents | Any-chain deposit → USDC on Monad (real Base → Monad run on 14 Oct), feeding deposit-and-follow and the agent wallet that pays Nansen |
| Nansen | Leader discovery, wallet quality and smart-money alignment, paid per call with x402 in Monad USDC |
| Kimi | Signed AI risk analyst (see rule 4) |
| Alchemy | Monad RPC (primary, with fallback) for the web and keeper + Notify webhook → Telegram alerts |
| MetaMask | `mm copas` Agent Wallet plugin: 13 commands, mandatory risk limits, tighten-only edits, 24 h outflow cap |
| x402 / ERC-8004 | Pay-per-call risk reports on Monad; AI agent leader #2209 with per-epoch onchain reputation |

## Design rules

1. **The backend never holds follower funds.** Funds sit in a `FollowerVault` owned by the follower's passkey EOA, and withdrawals only go to that owner.
2. **Copy-only.** Anyone can call `sync()`, but it can only move the follower toward `ratio × leader position`, within the follower's caps, stop-loss and leverage limit. Bots have no discretion.
3. **No oracle for money logic.** Equity, drawdown, breach and settlement all come from Perpl views read in the same block.
4. **AI explains, rules execute.** Kimi K3 (official Moonshot API) explains the numbers and gives three reasons *not* to follow; every answer carries Kimi's Request Signature, verified server-side ([`docs/KIMI.md`](docs/KIMI.md)). Every action is deterministic contract logic.
5. **No silent rule changes.** A leader can change its mandate, but only from the next epoch, and a follower vault only copies under terms its owner accepted. If the live mandate is looser (higher fee, drawdown, leverage, size or more markets), `sync` unwinds the vault to flat until the owner accepts, and the fee is always charged at the accepted rate.
6. **Honest risk.** The UI always shows *max protection = bond / follower AUM* and the remaining risks. The contracts are unaudited, so mainnet deposits are capped.

## Repository

| Folder | What | Sponsor tech |
|---|---|---|
| [`contracts/`](contracts) | `CopasRegistry`, `LeaderBook` (units, epochs, mandate, bond, breach), `FollowerVault` (copy-only sync, caps, claims, referral, mandate consent), `UnderwriterPool`, `BreachMarket` (UP/DOWN per leader epoch), `AgentLeaderRegistry`. Unit, invariant and mainnet-fork tests | Monad, Perpl, AUSD, ERC-8004 |
| [`web/`](web) | Next.js app (Mera passkey accounts, Dynamic email wallets and an unfollow-only delegated guard): bonded leaderboard, leader profile, follow ticket, vault, become-leader, underwrite, DOWN market, proof page with reproducible breach math, plus a full **Perpl analytics and risk dashboard** (protocol and wallet level) | Mera passkeys, Perpl, Envio, Telegram |
| [`indexer/`](indexer) | Envio HyperIndex v3: all Perpl fill, position, liquidation, funding and collateral events plus aggregates, and the Copas contracts via dynamic registration | Envio |
| [`keeper/`](keeper) | Copy sync, checkpoint and epoch bot; Privy server wallet with policy, gas sponsorship and a DENY demo; Dynamic MPC wallets as LeaderBook operators (agent #2209, and a server wallet that trades on Perpl behind a Copas allowlist); ERC-8004 feedback; alerts | Privy, Dynamic, Alchemy, Telegram |
| [`services/`](services) | Backtest using the same math as the contracts, LLM risk analyst with EIP-191 receipts, Nansen discovery (API key + x402), x402 pay-per-call report on Monad testnet, tx simulation, track-record attestation | OpenRouter, Nansen, x402 (Monad facilitator) |
| [`cre/`](cre) | Chainlink CRE workflow `copas-risk-guardian`: reads leaders, sanity-checks prices, asks an LLM (OpenRouter) for a structured risk score, then a consumer contract checkpoints risky leaders | Chainlink CRE |
| [`onramp/`](onramp) | Any-chain deposit-and-follow via Aurora 1Click / Intents Connect recipe, Kuru Flow swap to AUSD, Socket V3 deposit address, Kuru market script for DOWN tokens | Aurora, Kuru, Socket |
| [`plugin/`](plugin) | MetaMask Agent Wallet plugin `mm copas` (13 commands, mandatory risk limits, outflow cap) | MetaMask |
| [`docs/`](docs) | [`SPEC.md`](docs/SPEC.md) (product and technical spec) and [`STATUS.md`](docs/STATUS.md) (feature tracker) | |

Each app folder has its own README with setup, env vars, and what is live versus mocked. Deployed contract addresses go in `contracts/deployments/`.

## Try it on Monad testnet

Copas is live on Monad testnet (chain `10143`), trading on the Perpl testnet exchange. All addresses are in [`contracts/deployments/10143.json`](contracts/deployments/10143.json).

1. Open the web app at https://copas-mocha.vercel.app and choose **Create passkey account**. You get no seed phrase, and no key is stored on any server. Use a browser and passkey manager with WebAuthn PRF: Windows 11, iCloud Keychain, Google Password Manager or 1Password. A local Chrome desktop profile does not support PRF.
2. Open the account menu and choose **Get testnet MON + AUSD**. You receive 1 MON for gas plus 10,000 AUSD from the Perpl testnet faucet (`0xd236c18d274e54faccc3dd9dda4b27965a73ee6c`, `requestFunds(address)`).
3. Follow a leader from the leaderboard, open your vault in **Me**, and watch the copied position. Alternatively, open **Become a leader** to post a bond and a mandate.

Live demo objects:

| | Address |
|---|---|
| Registry | `0xA8BA57c7Af1d9A28660653E0439A180c86D03e3d` |
| Active leader (bond 50 AUSD, BTC long copied 50% by a follower vault) | book `0xda695cB060c7e2dF0b5c36EA591eA69399463D90` |
| Breached leader (bond slashed, follower claimed its loss) | book `0xb1B08F6a0642c51b48c1916136458A769a1c5208`, vault `0x38E8EbBD7Bd291036A0EFe4a6eFa3BCcd27D74ff` |
| Short copied 1:1 (traded by a Dynamic MPC operator wallet) | book `0xE31302DA2B0dA7898416E630dA75c837139dBE1B`, vault `0xe8eAA63Aba51C6a41e1b7ce31B3E91DC9E1E1119` |
| AI agent leader (ERC-8004 #2209) | book `0xbC277432C927996E5F91a2D356289895e1415958` |
| Encrypted strategy feed (Mera second PRF key) | leader book `0x1A6F9D5ccbbCC8561896311AcBa0be8B963E233E`, `CopasFeed` `0x75d52573C684C7799778Da633fDceB80297d7718` |

To reproduce from scratch, run `contracts/deploy-testnet.sh`, then `script/Seed.s.sol` (bonded leader with a follower copying a trade), then `script/Breach.s.sol` (breach, slash, claim; run phase 2 one epoch later).

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
