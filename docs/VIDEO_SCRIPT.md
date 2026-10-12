# Copas video scripts

Two required videos (Metropolis rules): **technical demo ≤ 3:00** (live product only, no slides or code) and **pitch ≤ 2:00** (team, problem, why now). Voice-over in English. Keep it plain: screen recording, no launch-style animation (several judges dislike it). Write "onchain", no hyphen.

Live testnet objects used below (Monad testnet 10143, `contracts/deployments/10143.json`):

| What | Address |
|---|---|
| Good leader (book) | `0xda695cB060c7e2dF0b5c36EA591eA69399463D90` — bond 50, BTC long, follower copied 50% |
| Breach leader (book) | `0xb1B08F6a0642c51b48c1916136458A769a1c5208` — bond 25, breached in epoch 2 |
| Breach follower vault | `0x38E8EbBD7Bd291036A0EFe4a6eFa3BCcd27D74ff` — claimed its loss from the slashed bond |
| Registry | `0xA8BA57c7Af1d9A28660653E0439A180c86D03e3d` |

Explorer: `https://testnet.monadexplorer.com/address/<addr>`

---

## 1. Technical demo (target 2:50)

**Before recording**
- `web`: `pnpm dev`, browser at 100% zoom, 1440×900, language EN (Settings), dark mode off unless it reads better.
- Indexer running (Hasura `localhost:8080`) so `/analytics` has fresh mainnet data.
- Wallet funded on testnet (MON + AUSD from faucet `0xd236…e6c` `requestFunds`). Mera passkey: record on a device where PRF works (Windows 11 / iCloud Keychain / 1Password). Chrome desktop local profile does **not** work.
- Tabs open in order: `/`, `/leader/0xda69…`, `/follow/0xda69…`, `/me`, `/leader/0xb1B0…`, `/proof`, `/analytics`, explorer tx of the breach, terminal with `mm copas leaders`.

| Time | Screen | Voice-over |
|---|---|---|
| 0:00–0:12 | `/` leaderboard, cursor on the bond seal | "This is Copas, copy trading on Monad where every leader has money on the line. Each leader here posted an AUSD bond and a mandate. These are live contracts on Monad testnet, trading on Perpl." |
| 0:12–0:35 | `/leader/0xda69…`: bond, mandate (max DD 15%, 5x, BTC/ETH/SOL/MON), live drawdown, protection | "The mandate is enforced by the contracts. Max drawdown 15 percent, max 5x leverage. Equity comes straight from Perpl state in the same block, no oracle. Protection is shown honestly: bond divided by follower capital." |
| 0:35–1:05 | `/follow/0xda69…`: set ratio, own caps, stop-loss → sign with passkey | "Following takes one passkey signature. No seed phrase. My money goes into a vault that I own, not to the leader and not to us. I set my own caps: ratio, max leverage, stop-loss. The vault can only copy toward the leader's position, inside my limits." |
| 1:05–1:25 | `/me`: vault, copied BTC position, entry price next to the leader's | "The leader opened a BTC long on Perpl, and anyone can call sync to copy it. Here is my vault holding the same position at half size, a few dollars from the leader's entry." |
| 1:25–2:05 | `/leader/0xb1B0…` status **Breached**, then explorer: `Breached` event, follower `ClaimedSlash` | "Now the case that matters. This leader broke the mandate. The checkpoint saw the drawdown, flagged the breach in the same transaction, and slashed the whole bond into a pot. The follower vault unwound automatically, and the follower claimed their loss back from the pot, paid straight to their own wallet. No vote, no admin key, no support ticket." |
| 2:05–2:25 | `/proof`: click Recompute for the breach | "Anyone can check it. The proof page recomputes the drawdown from Perpl state and gets the same number as the contract." |
| 2:25–2:40 | `/analytics`: Perpl risk dashboard (Envio) | "Leaders are picked using a full Perpl analytics dashboard, indexed by Envio: PnL, liquidations, funding, per wallet and per market." |
| 2:40–2:50 | terminal `mm copas leaders` / `mm copas leader 0xda69…` | "And the same flows run from the MetaMask Agent Wallet with `mm copas`, with mandatory risk limits. Copas: copy traders who have skin in the game." |

**Cut list if over time:** drop the `mm copas` shot first, then shorten `/analytics` to 5 s.

---

## 2. Pitch (target 1:50)

Face-cam for the opening and closing, screen for the middle.

| Time | Visual | Voice-over |
|---|---|---|
| 0:00–0:15 | Face-cam | "I'm [name], from [city], Indonesia, part of the Ethereum Jakarta / DevWeb3Jogja community. I build trading tools, and I've watched friends lose their savings copying traders on social media." |
| 0:15–0:40 | Screen: stat card | "On Perpl, 71 percent of traders lose money within 30 days. Copy trading should help, but today the leader takes no risk. When they blow up, followers pay and the leader just opens a new account." |
| 0:40–1:05 | `/leader` page with the bond seal | "Copas flips that. To get followers, a leader posts an AUSD bond and declares a mandate. Breach it, and the bond is slashed automatically to the followers, enforced by contracts reading Perpl directly. Followers keep custody in their own vault, signed with a passkey." |
| 1:05–1:25 | Breach screen, then explorer | "This runs today on Monad: a leader breached on testnet, and the follower was paid back onchain, with no human in the loop. Monad's speed lets us copy every trade and check every mandate in real time, cheaply." |
| 1:25–1:40 | Screen: who it's for | "The first users are retail dollar savers in Southeast Asia who already hold stablecoins and want a yield they can understand. Leaders get a credible track record they can't fake." |
| 1:40–1:50 | Face-cam | "Copy trading where the leader has skin in the game. That's Copas." |

Fill before recording: name, city, and any traction numbers (testers, follows, waitlist). Real numbers beat adjectives; replace the 1:25 line with them if you have them.

---

## Recording checklist
- [ ] Breach demo phase 2 has run (`contracts/script/Breach.s.sol`, `BREACH_PHASE=2`); breach leader shows **Breached** in the web.
- [ ] Leader page "Checkpoints and breaches" panel shows real data (currently labeled mock). If not fixed, skip that panel in the shot.
- [ ] Upload: YouTube unlisted or Loom, ≤ 3:00 and ≤ 2:00. Links go in the submission form and the README.
