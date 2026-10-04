# Copas keeper

This Node service keeps Copas running. It does seven jobs:

- copies leader fills to follower vaults with `FollowerVault.sync`
- checkpoints leaders
- rolls epochs
- unwinds vaults after a breach or a stop-loss
- settles BreachMarket series
- posts ERC-8004 reputation
- sends alerts

The keeper has **no discretion and holds no funds**. Every call it makes (`sync`, `checkpoint`, `rollEpoch`, `touch`, `settle`) is permissionless and bounded by the contracts. If the keeper is down, anyone can make the same calls. The Privy policy is a second layer on top: it stops the keeper wallet from calling anything else.

## Run

```bash
pnpm install
cp .env.example .env          # set CHAIN_ID + signer (see below)
pnpm test                     # vitest: pure decision logic
pnpm start                    # needs ../contracts/deployments/<CHAIN_ID>.json
```

Node 22+ is required because the service uses `process.loadEnvFile`. If the deployments file is missing, startup exits with a clear error. `contracts/script/Deploy.s.sol` writes that file with the keys `registry, breachMarket, agentRegistry, exchange, ausd, identity8004, block`.

### Signer modes

- `LOCAL` uses `KEEPER_PRIVATE_KEY`, for dev and testnet. The wallet pays its own MON gas. Nonces are managed locally, so several txs can be in flight at once.
- `PRIVY` uses a Privy server wallet through `@privy-io/node` 0.35. Each tx is sent as `eth_sendTransaction` on the wallet RPC with `sponsor: true` (Privy native gas sponsorship), so the wallet address needs no MON. Setup:
  1. Set `PRIVY_APP_ID` and `PRIVY_APP_SECRET`. In the Privy dashboard, enable TEE execution and gas sponsorship for Monad and Monad Testnet. Mainnet sponsorship needs prepaid credits.
  2. Run `pnpm privy:setup`. It creates the policy from `privy/policy.json` (chain 143) or `privy/policy.10143.json`, then creates a wallet with that policy attached. A P-256 authorization key owns both. If `PRIVY_AUTHORIZATION_KEY` is empty, the script generates one. Paste the printed values into `.env`.
  3. Run `pnpm privy:deny-demo`. The keeper wallet deliberately tries `AUSD.transfer`. Privy refuses it, and the script saves the refusal to `logs/deny.json`, which is served at `GET /proof/deny` for the web `/proof` page.

### Privy policy (`privy/policy*.json`)

| Rule | Action |
|---|---|
| `eth_sendTransaction`, chain 143/10143, value 0, calldata function in {`sync(uint256)`, `checkpoint()`, `rollEpoch()`, `touch()`, `settle(address,uint256)`} | ALLOW |
| `eth_sendTransaction` to the ERC-8004 ReputationRegistry, function `giveFeedback` only | ALLOW |
| any tx `to` AUSD or the Perpl Exchange | DENY |
| `eth_sign7702Authorization`, `personal_sign`, `eth_signTypedData_v4` | DENY |

Privy denies everything else by default.

**Known limit:** each user gets their own FollowerVault, deployed at runtime. So the ALLOW rule cannot list every Copas address in `to`, and a `to` list is capped at 100 values anyway. The rule pins the function selectors instead. Because the wallet holds no funds, a `sync()` call on some unrelated contract cannot lose anything.

To pin `to` as well:
1. Create a Privy *condition set* named `copas_contracts`.
2. Use `"operator": "in_condition_set"` in the rule.
3. Have the keeper append each new vault or leader on `VaultCreated`/`LeaderCreated`, through REST `condition_sets/{id}/condition_set_items`.

This isn't built because node SDK 0.35 has no helper for that API.

## What it does

| Trigger | Action |
|---|---|
| A Perpl `Position*` event (Opened/Increased/Decreased/Closed/Inverted/Liquidated/Deleveraged/Unwound) whose `accountId` is a Copas leader's `LeaderBook.accountId()` | `sync(perpId)` on every vault following that leader, plus `LeaderBook.checkpoint()` |
| Every `CHECKPOINT_EVERY_BLOCKS` | Refresh all leaders (`registry.leaderBooks`) and call `checkpoint()` on the Active ones |
| `block.timestamp >= epochEnd` | `rollEpoch()`. Then, on `EpochRolled`: `touch()` the following vaults, `BreachMarket.settle(lb, e-1)`, and post ERC-8004 feedback |
| `Breached` | Alerts (breach and claim available), an immediate unwind scan of that leader's vaults, and `settle(lb, e)` |
| Every `UNWIND_SCAN_EVERY_BLOCKS` | For each (vault, market) holding a position whose target is now 0 (leader breached, unbonded, flat or flipped; vault paused or unfollowed): `sync(perpId)` |

**Idempotency.** Every job is first simulated with `eth_call` from the keeper address. If the simulation reverts (epoch still running, series already settled, and so on), there is nothing to do and the job is skipped. A `sync` whose simulated target equals the current lot is also skipped, so it costs no gas. Jobs are de-duplicated by key. If a trigger arrives while the same job is in flight, the job runs once more after it finishes. A failed tx is logged and counted, and never crashes the loop. Logs are structured JSON lines.

**Discovery.** Leaders come from `registry.leaderCount/leaderBooks`. Vaults come from `VaultCreated` logs: the first run backfills them from `deployments.block` in 100-block chunks, and the list is saved in `data/state-<chainId>.json`. Each vault's `leader()/following()/paused()/accountId()` is refreshed on `Followed`, `Unfollowed`, `FollowerRegistered` and `StopLoss`, and once per checkpoint period.

**Log source.** The keeper makes one `eth_getLogs` call per range of up to 100 blocks, filtered by event topics only. It then keeps only logs from the exchange or from known Copas addresses. With `MONAD_WS_URL` set, new heads arrive over WebSocket and wake the loop right away. Otherwise it polls every `POLL_MS`. On restart the live cursor starts at the current head. The periodic checkpoint, roll and unwind jobs catch up on state from the missed blocks, but alerts from the downtime are not replayed.

## ERC-8004 reputation (`ENABLE_8004_FEEDBACK=true`)

After each finished epoch of a leader with `AgentLeaderRegistry.agentOf(lb) != 0`, the keeper calls the ReputationRegistry v2.0.0:

- Mainnet `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63`, testnet `0x8004B663056A597Dffe9eCcC1965A193B7388713`. `getVersion()` returns "2.0.0" on both.
- IdentityRegistry: mainnet `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`, testnet `0x8004A818BFB912233c491871b3d84c89A494BD9e`. The testnet address is different from mainnet.
- The ABI was verified by probing the implementation bytecode behind the proxy (selector `0x3c036a7e`):
  `giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)`
- A clean epoch posts `value=100` with tags `copas` / `epoch-clean`. A breach posts `value=-100` with tags `copas` / `breach-drawdown`, `breach-leverage`, `breach-notional` or `breach-market`. The endpoint is `copas:<chainId>:<leaderBook>:epoch-<e>`.
- **Signer caveat:** the registry reverts with `"Self-feedback not allowed"` when the sender owns or operates the agent. So the keeper wallet must be a different address from both the agent owner and the agent wallet. That holds by default, because agent owners are leaders. The pre-send simulation catches the revert and logs a warning. Epochs that already got feedback are recorded in `data/state-*.json`.

## Alerts (G4)

**Telegram:** set `TELEGRAM_BOT_TOKEN` (get one from @BotFather). Users send the bot:
- `/start` for all alerts
- `/watch <leaderBook|vault>` to narrow them
- `/unwatch <addr>`, `/list`, `/stop`

Subscribers are stored in `data/subscribers.json`.

The keeper sends these alerts:
- leader opened, closed or was liquidated on a position
- drawdown reached 80% of the mandate (once per leader per epoch)
- breach
- claim available
- leader requested unbond
- follower stop-loss

### Alchemy Notify: `POST /webhooks/alchemy`

The endpoint checks that `x-alchemy-signature` equals the hex HMAC-SHA256 of the raw body, keyed with `ALCHEMY_WEBHOOK_SIGNING_KEY`. If it doesn't match, it returns 401. For each tx hash in the payload, it fetches the receipt, decodes the Copas and Perpl logs, and passes them to the same handler the poller uses. Logs are de-duplicated by `txHash:logIndex`, so an event that arrives both ways alerts once.

To create the webhook in the dashboard, go to *Data → Webhooks → Address Activity* and pick Monad Mainnet or Monad Testnet. Or use the API:

```bash
curl -X POST https://dashboard.alchemy.com/api/create-webhook \
  -H "X-Alchemy-Token: $ALCHEMY_AUTH_TOKEN" -H "content-type: application/json" \
  -d '{"network":"MONAD_TESTNET","webhook_type":"ADDRESS_ACTIVITY",
       "webhook_url":"https://<keeper-host>/webhooks/alchemy",
       "addresses":["<registry>","<breachMarket>","<leaderBook...>","<vault...>"]}'
# add new leaderBooks/vaults later:
# PATCH https://dashboard.alchemy.com/api/update-webhook-addresses
#   {"webhook_id":"wh_...","addresses_to_add":["0x..."],"addresses_to_remove":[]}
```

Use `MONAD_MAINNET` for chain 143. Copy the webhook's *signing key* into `ALCHEMY_WEBHOOK_SIGNING_KEY`. Address-activity webhooks only fire on value or token transfers that touch the listed addresses: deposits, claims and slashes. The poller covers every other event. The webhook is just an extra low-latency path.

## HTTP (port `PORT`, CORS open for the web app)

- `GET /health` returns `{ ok, lastBlock, processedBlock }`. `ok` is false when processing lags more than 300 blocks behind.
- `GET /metrics` returns:
  - the signer and the last block
  - counters: `syncsSent`, `syncsSkipped`, `checkpoints`, `rolls`, `touches`, `settles`, `feedbacks`, `txFailed`, `breachesSeen`, `leaderFills`
  - `latencyBlocks {last, avg, p50, max}`: blocks from the leader's fill to the follower's sync receipt
  - `recentTx` and `recentAlerts`
- `GET /proof/deny` returns `logs/deny.json`.

## Layout

- `src/logic.ts`: pure logic, tested
- `src/keeper.ts`: log watching and jobs
- `src/signer.ts`: LOCAL/PRIVY signers
- `src/erc8004.ts`, `src/alerts.ts`, `src/http.ts`, `src/config.ts`
- `scripts/privy-*.ts`
- `privy/policy*.json`
