---
name: copas
description: Use when the user wants to copy-trade (follow, mirror) a bonded Perpl perps trader on Monad with hard risk limits, check or compare Copas leaders (bond, mandate, drawdown, breach history), manage a Copas FollowerVault (create, deposit, withdraw, tighten limits, unfollow, sync), see vault PnL and positions, or claim compensation after a leader breached its mandate. Entry point for the `mm copas` commands of the mm-plugin-copas plugin.
license: MIT
metadata:
  author: copas
  version: "0.1.0"
  pluginPackage: mm-plugin-copas
  minCliVersion: ">=7.0.0 <8.0.0"
---

# Copas (`mm copas`)

Copas is copy trading on Monad where every leader posts an AUSD bond and declares a mandate
(max drawdown, leverage, notional, markets). Followers copy the leader's Perpl positions through
their own `FollowerVault`, whose limits are enforced by the contract. If a leader breaks the
mandate, the bond is slashed and paid to followers, pro rata, up to their real loss.

Every write goes through the Agent Wallet (`walletExecutor`), so signing, Guard Mode policy,
outflow limits and MFA all apply. The plugin never handles keys or tokens.

## Command routing

| User intent | Command |
| --- | --- |
| "Who can I copy?" / compare traders | `mm copas leaders` |
| Details on one trader, is it safe, has it breached | `mm copas leader <leaderBook>` |
| Set up copy trading / show my vault | `mm copas vault` (`--create` to make one, optional `--ref <addr>` once) |
| Fund the vault | `mm copas deposit <amount>` |
| Start copying | `mm copas follow <leaderBook> --ratio --max-notional --max-leverage --chase-bps --band-bps --stop-loss-bps --markets [--ref] --yes` |
| Reduce risk (smaller size, lower leverage, fewer markets, tighter stop) | `mm copas tighten [any limit flag]` |
| Stop copying | `mm copas unfollow`, then `mm copas sync <market>` per open market |
| Copy the leader's latest move now | `mm copas sync <BTC|ETH|SOL|MON>` |
| How am I doing / PnL / positions / anything to claim | `mm copas status` |
| Is this leader inside its mandate? Enforce it | `mm copas checkpoint <leaderBook>` (permissionless; slashes on a breach) |
| Get paid after a breach | `mm copas claim <leaderBook> <epoch>` (the exact command is listed in `status`) |
| Back a leader / earn fees as an underwriter | `mm copas underwrite <leaderBook> <amount>`; leave with `--exit` (twice: request, then withdraw after the unbond epoch) |
| Trade Perpl directly (not copy) | Not this plugin. Use a Perpl trading plugin (e.g. `mm-plugin-perpl`) |
| Take money out | `mm copas withdraw <amount>` |

All commands take `--chain-id 143` (Monad) or `--chain-id 10143` (testnet; the default while Copas is testnet-only), `--vault <addr>`
where relevant, and the host's `--json`. Amounts are AUSD (6 decimals), e.g. `25` or `12.5`.

## Safety rules (mandatory)

1. **Never follow without limits.** `follow` requires all seven limits. Do not invent values. Ask
   the user for each one, or propose conservative values and get an explicit "yes" before using
   them. Conservative starting point for a small account: `--ratio 0.25 --max-notional 25
   --max-leverage 2 --chase-bps 50 --band-bps 30 --stop-loss-bps 1000 --markets BTC`.
2. **Show the risk disclosure and get consent.** `follow` prints "max protection = bond / AUM".
   Read it to the user. Only pass `--yes` after the user confirms in this conversation, for this
   leader and these limits.
3. **Never raise limits without explicit user confirmation.** `tighten` can only lower risk (the
   plugin and the contract both refuse increases). Raising limits means `unfollow` + `follow`
   with new values; do that only if the user explicitly asks for the higher numbers.
4. **Never work around a refusal.** If a command fails with `COPAS_OUTFLOW_CAP`, `COPAS_SYNC_REVERTED` (retry later, don't loosen limits),
   `COPAS_DEPOSIT_CAP`, `COPAS_CAPACITY`, `COPAS_LIMITS_REQUIRED`, `COPAS_NOT_TIGHTER`, or the
   host pauses with `AWAITING_MFA`, stop and tell the user. Do not split a withdrawal to dodge the
   daily cap, do not edit `~/.copas/config.json` to raise `maxWithdrawPerDay`, and do not retry
   with different flags unless the user asks.
5. **Check before follow.** Run `mm copas leader <addr>` first. Do not suggest a leader whose
   status is not `Active`, that breached recently, or whose drawdown is close to its mandate,
   without saying so plainly.
6. **Don't overstate protection.** Losses inside the leader's declared drawdown are not
   compensated, and payout is capped at bond / AUM. Contracts are unaudited; mainnet deposits are
   capped per vault.

## Typical flow

```
mm copas leaders --chain-id 10143
mm copas leader 0xLeaderBook --chain-id 10143
mm copas vault --create --chain-id 10143
mm copas deposit 25 --chain-id 10143
mm copas follow 0xLeaderBook --ratio 0.25 --max-notional 25 --max-leverage 2 \
  --chase-bps 50 --band-bps 30 --stop-loss-bps 1000 --markets BTC,ETH --chain-id 10143   # shows disclosure, asks
mm copas sync BTC --chain-id 10143
mm copas status --chain-id 10143
```

## How things work (for explaining to users)

- `ratio` is a multiple of the leader's size (0.25 = a quarter). Exposure is also capped by
  `max-notional`, and leverage by the lower of your `max-leverage` and the leader's mandate.
- `chase-bps`: don't add to a position when the mark price has moved more than this from the
  leader's entry. `band-bps`: IOC limit price = mark ± band. `stop-loss-bps`: copying pauses for
  the epoch if vault equity falls this far.
- `sync` is permissionless and copy-only: it can only move the vault toward ratio × the leader's
  live position inside your limits. A keeper normally calls it; the command lets you trigger it.
- Breach payouts: `claim` pays `min(pot × yourCap / totalCap, yourLoss)` straight to your wallet,
  within `claimWindowEpochs` after the breach.
- `checkpoint` measures the leader's unit-price drawdown from the epoch high and its leverage; past
  the mandate it marks the epoch Breached and slashes bond + fee escrow + underwriter pool into the
  pot. Followers have a reason to call it, so does anyone watching.
- Underwriters (`underwrite`) are second loss after the leader's bond and earn a share of the
  leader's released fees. Exit takes one unbond epoch: `--exit` once to request, again after
  the unlock epoch to withdraw.
- Some leaders are AI agents: `leader`/`leaders` show `agent` (ERC-8004 identity id + registered
  name) when the book is linked in the AgentLeaderRegistry. The agent key trades as `operator`;
  the human owner's bond still stands behind it.
- Withdrawals are checked against a plugin-level rolling 24h cap (`maxWithdrawPerDay`, default
  100 AUSD; env `COPAS_MAX_WITHDRAW_PER_DAY` or `~/.copas/config.json`) before the tx is built,
  in addition to the Agent Wallet's own outflow policy.

## Preflight and troubleshooting

- `mm doctor` must show authenticated and initialized; plugins need `mm config set experimentalPlugins true`.
- `COPAS_NOT_DEPLOYED`: no `deployments/<chainId>.json` shipped for that chain; use the other chain or set `COPAS_DEPLOYMENTS_DIR`.
- `COPAS_NO_VAULT`: run `mm copas vault --create`.
- `COPAS_TX_FAILED`: the wallet job failed or was denied; check `mm wallet requests list`.
- In Guard Mode, allowlist the vault, registry and AUSD addresses so each copy step doesn't need 2FA.
