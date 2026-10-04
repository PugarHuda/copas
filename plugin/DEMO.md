# `mm copas` demo script (under 5 minutes)

Goal: show a real flow on Monad testnet (10143) where an agent copies a bonded leader through the
MetaMask Agent Wallet, with limits enforced and every tx signed by the wallet.

## Before recording

- `mm login && mm init` (server wallet, **Guard Mode on**). Fund the wallet with testnet MON and
  ~60 testnet AUSD.
- Copas deployed on 10143, `deployments/10143.json` present (`npm run sync`), plugin installed.
- One leader (second wallet) bonded with an open BTC long; its LeaderBook address at hand.
- `export COPAS_CHAIN_ID=10143 COPAS_MAX_WITHDRAW_PER_DAY=20`.
- Terminal font large, two panes: terminal + Monad explorer.

## Script

| Time | Show | Say |
| --- | --- | --- |
| 0:00-0:20 | Title card | "Copy trading where the trader posts a bond. Break the promise, followers get paid. As a MetaMask Agent Wallet plugin." |
| 0:20-0:40 | `mm plugins inspect mm-plugin-copas` | Capabilities per command: read-only vs wallet-submit. No keys, no tokens. |
| 0:40-1:10 | `mm copas leaders` then `mm copas leader 0xLB` | Bond, mandate (max DD, leverage, markets), drawdown vs mandate, breach history. |
| 1:10-1:30 | `mm copas vault --create` | Tx goes through the Agent Wallet executor; point at the "Copas: create FollowerVault" intent. |
| 1:30-1:50 | `mm copas deposit 25` | Exact-amount approve + deposit, two wallet steps. |
| 1:50-2:10 | `mm copas follow 0xLB --ratio 0.5` | Refused: `COPAS_LIMITS_REQUIRED`, lists every missing limit. |
| 2:10-2:50 | `mm copas follow 0xLB --ratio 0.5 --max-notional 25 --max-leverage 2 --chase-bps 50 --band-bps 30 --stop-loss-bps 1000 --markets BTC` | Risk disclosure (max protection = bond / AUM), confirmation prompt, then the follow tx. |
| 2:50-3:20 | `mm copas sync BTC` then `mm copas status` | Vault now long BTC at half the leader's size; equity, PnL, limits. |
| 3:20-3:40 | `mm copas tighten --max-leverage 3` then `--max-leverage 1` | First refused (`COPAS_NOT_TIGHTER`), second accepted. |
| 3:40-4:10 | `mm copas withdraw 15`, then `mm copas withdraw 10` | First passes; second refused by the 20 AUSD/day plugin cap before any tx is built. |
| 4:10-4:40 | (pre-recorded) leader breaches, `mm copas status` shows claimable; `mm copas claim 0xLB <epoch>` | Slashed bond paid to the follower's wallet. |
| 4:40-5:00 | Agent chat using `skills/copas/SKILL.md` | "Follow the safest leader with 25 AUSD": the agent proposes limits and asks before `--yes`. |

## Fallbacks

- If the breach can't happen live, record the claim on a leader with a short (1h) demo epoch beforehand.
- If Guard Mode pauses with `AWAITING_MFA`, approve on the phone on camera. That is part of the point.
