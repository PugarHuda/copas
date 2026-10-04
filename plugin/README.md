# mm-plugin-copas

A [MetaMask Agent Wallet](https://docs.metamask.io/agent-wallet/) plugin that adds `mm copas`:
copy trading on Monad with bonded leaders, on-chain risk limits, slashing payouts and outflow caps.

Copas leaders post an AUSD bond and declare a mandate (max drawdown, leverage, notional, markets).
You copy their [Perpl](https://perpl.xyz) perps positions through your own `FollowerVault`, which only
moves toward ratio × the leader's live position inside your limits. If the leader breaks the
mandate, the bond is slashed and followers claim it.

**Every transaction goes through the Agent Wallet executor.** The plugin builds calldata with viem
and hands it to `ctx.walletExecutor`, so signing, Guard Mode policy, outflow limits and MFA all
apply unchanged. It never touches keys, the session or CLI tokens.

## Commands

| Command | What it does | Capabilities |
| --- | --- | --- |
| `mm copas leaders` | Bonded leaders: status, bond, mandate, epoch, unit price, protection, capacity | wallet-read |
| `mm copas leader <addr>` | One leader + drawdown vs mandate + breach history | wallet-read |
| `mm copas vault [--create] [--ref <addr>]` | Show/create your FollowerVault; optional one-time referrer | read + submit |
| `mm copas deposit <amount>` | Exact-amount AUSD approve + deposit, respects the per-vault cap | read + submit |
| `mm copas follow <leader> --ratio --max-notional --max-leverage --chase-bps --band-bps --stop-loss-bps --markets [--ref] [--yes]` | Follow with mandatory limits, after a risk disclosure | read + submit |
| `mm copas tighten [limit flags]` | Lower limits only | read + submit |
| `mm copas unfollow` | Stop copying | read + submit |
| `mm copas sync <market>` | Move the vault toward its copy target in one market | read + submit |
| `mm copas claim <leader> <epoch>` | Claim slashed-bond payout for a breached epoch | read + submit |
| `mm copas withdraw <amount>` | Withdraw to your wallet, under the plugin's 24h outflow cap | read + submit |
| `mm copas status` | Equity, epoch PnL, positions, limits, claimable breaches | wallet-read |

All commands target Monad (`targetChains: [143, 10143]`); pick with `--chain-id` or `COPAS_CHAIN_ID`
(default 143). Markets: mainnet BTC=1, MON=10, ETH=20, SOL=31; testnet BTC=16, ETH=32, SOL=48, MON=64,
mapped to the registry's market list for the vault's bitmask.

Safety built in:

- `follow` refuses unless all seven limits are given, then prints a risk disclosure
  ("max protection = bond / AUM") and requires confirmation (prompt, or `--yes` when headless).
- `tighten` refuses any change that raises risk (the contract enforces the same).
- `deposit` checks the registry's `maxVaultDepositCNS`, wallet balance and Perpl's minimum account open,
  and approves the exact amount only.
- `withdraw` enforces `maxWithdrawPerDay` (rolling 24h, default 100 AUSD) **before** the tx is built.
  Set it with `COPAS_MAX_WITHDRAW_PER_DAY=50` or `~/.copas/config.json`: `{ "maxWithdrawPerDay": "50" }`.
  The ledger is `~/.copas/withdrawals.json` (per machine).

The agent skill is in [`skills/copas/SKILL.md`](skills/copas/SKILL.md).

## Install

Requirements: Node >= 22.18, `@metamask/agent-wallet` >= 7.0.0 (`npm i -g @metamask/agent-wallet`),
then `mm login && mm init`.

```bash
mm config set experimentalPlugins true
```

From npm (once published):

```bash
mm plugins install mm-plugin-copas
```

From source (local development):

```bash
cd copas/plugin
npm install
npm run build          # syncs ABIs + deployments, tsc, oclif manifest
npm test               # argument parsing + calldata encoding tests

# The plugin must load the SAME @metamask/agent-wallet as the host CLI, or the host rejects
# its commands with PLUGIN_INVALID_BASE. Point the dev copy at the global install:
#   macOS/Linux:
ln -sfn "$(npm root -g)/@metamask/agent-wallet" node_modules/@metamask/agent-wallet
#   Windows (PowerShell):
#   Remove-Item -Recurse -Force node_modules\@metamask\agent-wallet
#   New-Item -ItemType Junction -Path node_modules\@metamask\agent-wallet -Target "$(npm root -g)\@metamask\agent-wallet"

mm config set experimentalAllowUnverifiedInstalls true
mm plugins install "file:$PWD" --accept-permissions
mm copas --help
```

On Windows, `mm plugins install file:<dir>` breaks on paths with spaces (it reports "Invalid npm
package name"). Use the 8.3 short path, e.g. `file:C:/HACKAT~1/MONADM~1/copas/plugin`
(`cmd /c for %I in (.) do @echo %~sI` prints it).

Remove between iterations with `mm plugins uninstall mm-plugin-copas`.

### Contract addresses

The plugin reads `deployments/<chainId>.json` (keys `registry`, `exchange`, `ausd`, optionally
`breachMarket`, `agentRegistry`), copied from `copas/contracts/deployments/` by `npm run sync`
(also part of `build`). Override the folder with `COPAS_DEPLOYMENTS_DIR`. Without a file the
commands fail with `COPAS_NOT_DEPLOYED`.

### Guard Mode

Add the registry, your vault and AUSD to the Agent Wallet allowlist so copy steps don't each need
2FA. Policy is never bypassed: a step that needs approval pauses with `AWAITING_MFA`.

## Layout

```
src/commands/copas/*.ts   one file per command (PluginCommand, ids match package.json#mm)
src/lib/core.ts           pure: parsing, limits, calldata encoding, outflow cap (unit-tested)
src/lib/host.ts           deployments, active wallet, reads, the single walletExecutor write path
src/lib/views.ts          leader / vault / claimable read models
abis/, deployments/       synced from the monorepo
skills/copas/SKILL.md     agent instructions
test/core.test.ts         node --test
```
